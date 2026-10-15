"""Bounded swap admission under the owner's relaxed RAM requirement."""

from dataclasses import replace
from pathlib import Path
import subprocess
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts/runtime"))
import host_resources as resources
from host_admission import AdmissionError
from tests.unit_tests.test_host_admission import fixture, poll, release, request


def swap_sample(**changes):
    return replace(
        resources.MemorySnapshot(
            8 * resources.GIB,
            144 * resources.MIB,
            "normal",
            "darwin-vm-stat+memorystatus",
            load_ratio=0.2,
            reclaimable_estimate_bytes=400 * resources.MIB,
            swap_total_bytes=100,
            swap_free_bytes=1400 * resources.MIB,
        ),
        **changes,
    )


def darwin_sensor(monkeypatch, swap_output):
    monkeypatch.setattr(resources.sys, "platform", "darwin")
    monkeypatch.setattr(resources.os, "getloadavg", lambda: (2, 1, 1))
    monkeypatch.setattr(resources.os, "cpu_count", lambda: 8)

    def command(argv):
        if "vm.swapusage" in argv:
            if isinstance(swap_output, Exception):
                raise swap_output
            return swap_output
        if "sysctl" in argv[0]:
            return "8589934592\n1"
        return (
            "Mach Virtual Memory Statistics: (page size of 16384 bytes)\n"
            "Pages free: 100.\nPages speculative: 50.\nPages purgeable: 25.\n"
            "Pages inactive: 200000.\nFile-backed pages: 500.\n"
            "Swapins: 3.\nSwapouts: 4.\n"
        )

    monkeypatch.setattr(resources, "command", command)
    return resources.memory_snapshot()


@pytest.mark.parametrize(
    "unit,factor", [("K", 1024), ("M", resources.MIB), ("G", resources.GIB)]
)
def test_darwin_reads_free_swap_separately_from_io(monkeypatch, unit, factor):
    sample = darwin_sensor(
        monkeypatch,
        f"total = 4096.00{unit}  used = 2695.25{unit}  free = 1400.75{unit}  (encrypted)",
    )
    assert sample.swap_free_bytes == int(1400.75 * factor)
    assert sample.swap_total_bytes == 7 * 16384
    assert sample.available_bytes == 175 * 16384
    assert sample.reclaimable_estimate_bytes == (500 - 50 - 25) * 16384 // 2


@pytest.mark.parametrize(
    "output",
    [
        "",
        "free = -1.00M",
        "free = nanM",
        "free = 3.00T",
        "free = 3.00MB",
        OSError("unavailable"),
        subprocess.TimeoutExpired("sysctl", 2),
    ],
)
def test_optional_swap_probe_failure_preserves_ram_telemetry(monkeypatch, output):
    sample = darwin_sensor(monkeypatch, output)
    assert sample.pressure == "normal"
    assert sample.available_bytes == 175 * 16384
    assert sample.swap_free_bytes is None


def test_normal_pressure_uses_bounded_swap_for_worker_and_heavy(tmp_path):
    admission, _, sensor, clock = fixture(tmp_path)
    sensor["sample"] = swap_sample()
    try:
        assert request(admission, tmp_path / "a", 100, "a")["state"] == "queued"
        assert admission.status()["swapCreditMiB"] == 0
        clock["now"] += 16
        assert poll(admission, "a", 100)["state"] == "active"
        assert (
            request(admission, tmp_path / "a", 100, "h", "heavy", parent_lease_id="a")[
                "state"
            ]
            == "active"
        )
        status = admission.status()
        assert status["headroomMiB"] == 512
        assert status["swapFreeMiB"] == 1400
        assert status["swapCreditMiB"] == 512
        assert status["immediateMiB"] == 144
        assert status["availableMiB"] == 1056
        assert status["reservedMiB"] == 256
        assert status["memoryUncertainty"] == "discounted-file-cache+bounded-swap"
        assert request(admission, tmp_path / "b", 101, "b")["state"] == "queued"
        release(admission, "h", 100)
        release(admission, "a", 100)
        assert poll(admission, "b", 101)["state"] == "active"
    finally:
        admission.close()


@pytest.mark.parametrize(
    "total,free,credit",
    [(8, 1400, 512), (4, 1400, 256), (8, 300, 150), (8, 0, 0), (8, None, 0)],
)
def test_swap_credit_is_capped_by_ram_and_actual_free_swap(
    tmp_path, total, free, credit
):
    admission, _, sensor, clock = fixture(tmp_path)
    sensor["sample"] = swap_sample(
        total_bytes=total * resources.GIB,
        swap_free_bytes=None if free is None else free * resources.MIB,
    )
    try:
        admission.status()
        clock["now"] += 16
        status = admission.status()
        assert status["swapCreditMiB"] == credit
        assert status["swapFreeMiB"] == free
        assert status["availableMiB"] == 544 + credit
    finally:
        admission.close()


@pytest.mark.parametrize(
    "bad", ["warning", "critical", "unknown", "load", "missing-load", "missing-counter"]
)
def test_swap_never_overrides_unsafe_signals(tmp_path, bad):
    admission, _, sensor, clock = fixture(tmp_path)
    sensor["sample"] = swap_sample(
        pressure=bad if bad in {"warning", "critical", "unknown"} else "normal",
        load_ratio=None if bad == "missing-load" else 1.2 if bad == "load" else 0.2,
        swap_total_bytes=None if bad == "missing-counter" else 100,
    )
    try:
        assert request(admission, tmp_path / "a", 100, "a")["state"] == "queued"
        clock["now"] += 16
        assert poll(admission, "a", 100)["state"] == "queued"
        assert admission.status()["swapCreditMiB"] == 0
        if bad == "warning":
            # Prove zero swap credit after recovery with ample RAM, rather
            # than relying only on the low-budget queued result above.
            sensor["sample"] = replace(
                sensor["sample"], available_bytes=2048 * resources.MIB
            )
            clock["now"] += 16
            assert poll(admission, "a", 100)["state"] == "active"
            status = admission.status()
            assert status["paused"] is False
            assert status["headroomMiB"] == 1024
            assert status["swapCreditMiB"] == 0
            assert status["availableMiB"] == 2448
    finally:
        admission.close()


def test_swap_io_reserve_can_exhaust_both_estimated_credits(tmp_path):
    admission, _, sensor, clock = fixture(tmp_path)
    sensor["sample"] = swap_sample()
    try:
        request(admission, tmp_path / "a", 100, "a")
        clock["now"] += 16
        sensor["sample"] = replace(
            sensor["sample"], swap_total_bytes=100 + 16 * 64 * resources.MIB
        )
        assert poll(admission, "a", 100)["state"] == "queued"
        status = admission.status()
        assert status["swapReserveMiB"] == 960
        assert status["availableMiB"] == 144
    finally:
        admission.close()


def test_free_swap_drop_reduces_credit_without_killing_active_owner(tmp_path):
    admission, _, sensor, clock = fixture(tmp_path)
    sensor["sample"] = swap_sample()
    try:
        request(admission, tmp_path / "a", 100, "a")
        clock["now"] += 16
        assert poll(admission, "a", 100)["state"] == "active"
        sensor["sample"] = replace(sensor["sample"], swap_free_bytes=0)
        assert (
            request(admission, tmp_path / "a", 100, "h", "heavy", parent_lease_id="a")[
                "state"
            ]
            == "queued"
        )
        assert admission.status()["swapCreditMiB"] == 0
        assert admission.status()["availableMiB"] == 544
        assert poll(admission, "a", 100)["state"] == "active"
    finally:
        admission.close()


def test_swap_credit_keeps_quarantined_reservations(tmp_path):
    admission, identities, sensor, clock = fixture(tmp_path)
    sensor["sample"] = swap_sample()
    try:
        request(admission, tmp_path / "a", 100, "a")
        clock["now"] += 16
        assert poll(admission, "a", 100)["state"] == "active"
        assert (
            request(admission, tmp_path / "a", 100, "h", "heavy", parent_lease_id="a")[
                "state"
            ]
            == "active"
        )
        identities.pop(100)
        assert request(admission, tmp_path / "b", 101, "b")["state"] == "queued"
        status = admission.status()
        assert status["quarantined"] == 2
        assert status["reservedMiB"] == 256
    finally:
        admission.close()


@pytest.mark.parametrize("bad", [-1, float("nan"), float("inf"), True, "512"])
def test_invalid_swap_capacity_is_rejected(tmp_path, bad):
    admission, _, sensor, _ = fixture(tmp_path)
    sensor["sample"] = swap_sample(swap_free_bytes=bad)
    try:
        with pytest.raises(AdmissionError, match="telemetry-invalid"):
            admission.status()
    finally:
        admission.close()
