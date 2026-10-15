"""Execute distributed examples; these checks do not measure agent compliance."""

from __future__ import annotations

import contextlib
import io
import json
import os
import re
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
EXAMPLE_ROOT = Path(os.environ.get("FORGEWRIGHT_SKILL_EXAMPLE_ROOT", ROOT))
NODE_PROBE = ROOT / "tests/fixtures/skills/reference-examples.cjs"


def _blocks(relative: str, language: str) -> list[str]:
    text = (EXAMPLE_ROOT / relative).read_text(encoding="utf-8")
    return re.findall(rf"```{language}\n(.*?)```", text, flags=re.DOTALL)


def _node_probe(name: str) -> dict:
    result = subprocess.run(
        ["node", str(NODE_PROBE), name, str(EXAMPLE_ROOT)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    return json.loads(result.stdout)


@pytest.mark.parametrize("skill", ["api-designer", "solution-architect"])
def test_openapi_examples_resolve_local_references_and_response_objects(skill: str):
    """The shipped OpenAPI artifact, not a copy of it, is the contract here."""
    specifications = [
        yaml.safe_load(code)
        for code in _blocks(f"skills/{skill}/SKILL.md", "yaml")
        if re.search(r"^openapi:", code, re.MULTILINE)
    ]
    assert specifications, f"No OpenAPI example in {skill}"
    for spec in specifications:
        pending = [spec]
        while pending:
            node = pending.pop()
            if isinstance(node, list):
                pending.extend(node)
            elif isinstance(node, dict):
                reference = node.get("$ref", "")
                if reference.startswith("#/"):
                    target = spec
                    for part in reference[2:].split("/"):
                        key = part.replace("~1", "/").replace("~0", "~")
                        assert key in target, f"{skill}: unresolved {reference}"
                        target = target[key]
                pending.extend(node.values())
        for name, response in spec.get("components", {}).get("responses", {}).items():
            assert "$ref" in response or isinstance(response.get("description"), str), (
                f"{skill}: {name} must be a Response Object, not a Schema Object"
            )


def test_generated_mcp_handler_keeps_shell_and_option_syntax_literal():
    result = _node_probe("mcp-arguments")
    assert result["sideEffects"] == [], result
    assert result["argv"] == result["expectedArgv"], result
    assert result["invalidRequestsRejected"] == 8, result
    assert result["unknownToolRejected"] is True, result
    assert result["cwdCorrect"] is True, result


def test_projectile_example_uses_engine_velocity_units_and_recycles_bodies():
    result = _node_probe("projectiles")
    assert result["distances"] == pytest.approx([600, 600, 600]), result
    assert result["inactiveBodyEnabled"] is False, result
    assert result["reuse"] == {"active": True, "visible": True, "enabled": True}, result


def test_eval_example_rejects_self_confidence_and_requires_independent_reference():
    code = next(
        code
        for code in _blocks("skills/eval-engineer/LITE.md", "python")
        if "def calculate_quality_score(" in code
    )
    namespace: dict = {}
    with contextlib.redirect_stdout(io.StringIO()):
        exec(compile(code, "eval-engineer-example", "exec"), namespace)
    grade = namespace["calculate_quality_score"]
    fabricated = json.dumps({"confidence": 0.95, "citations": [""]})
    assert grade(fabricated)["status"] != "PASS"
    for invalid in ["[]", "null", "{", '{"citations": null}']:
        assert grade(invalid)["status"] != "PASS"
    correct = json.dumps({"answer": "Paris", "citations": ["source-france"]})
    assert grade(correct)["status"] == "UNVERIFIED"
    reference = {"expected_answer": "Paris", "allowed_citations": {"source-france"}}
    assert grade(correct, **reference)["status"] == "PASS"
    assert grade(correct.replace("Paris", "Berlin"), **reference)["status"] == "FAIL"
    assert (
        grade(correct.replace("source-france", "invented"), **reference)["status"]
        == "FAIL"
    )
    assert (
        grade(correct.replace('["source-france"]', '[""]'), **reference)["status"]
        == "FAIL"
    )


def test_sre_daily_error_budgets_follow_availability_window():
    text = (EXAMPLE_ROOT / "skills/sre/SKILL.md").read_text(encoding="utf-8")
    rows = re.findall(
        r"\| \*\*Tier \d .*?\*\* \| ([\d.]+)% \| .*? \| ([\d.]+)(s|min) \|",
        text,
    )
    assert len(rows) == 4
    for availability, value, unit in rows:
        observed_seconds = float(value) * (60 if unit == "min" else 1)
        expected_seconds = 24 * 60 * 60 * (1 - float(availability) / 100)
        assert observed_seconds == pytest.approx(expected_seconds), availability
    burn_examples = re.findall(
        r"threshold: ([\d.]+)  # ([\d.]+)% of the full 30-day budget consumed in (\d+) hours?",
        text,
    )
    assert len(burn_examples) == 2
    for multiplier, percentage, hours in burn_examples:
        consumed = float(multiplier) * float(hours) / (30 * 24) * 100
        assert float(percentage) == pytest.approx(consumed)
