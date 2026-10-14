#!/usr/bin/env bash
# scripts/lite/telemetry.sh
# Forgewright Phase 1 — telemetry foundation.
# Append-only JSONL event stream + monthly aggregate report.
#
# Usage:
#   bash scripts/lite/telemetry.sh emit <event_type> <json_payload>
#   bash scripts/lite/telemetry.sh report [YYYYMM]
#
# Storage: .forgewright/telemetry/events-YYYYMM.jsonl
# Record:  {"ts":"<ISO-8601 UTC>","event":"<type>","data":{...}}
#
# Exit codes:
#   0 — success
#   1 — usage error / invalid payload / missing dependency

set -euo pipefail

# Colors
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[TELEMETRY]${NC} $*"; }
log_warn()  { echo -e "${YELLOW}[TELEMETRY] WARNING:${NC} $*" >&2; }
log_error() { echo -e "${RED}[TELEMETRY] ERROR:${NC} $*" >&2; }

# Find project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
if [[ -n "${FORGEWRIGHT_WORKSPACE:-}" ]]; then
  WORKSPACE_PATH="$FORGEWRIGHT_WORKSPACE"
  if command -v cygpath >/dev/null 2>&1; then
    WORKSPACE_PATH="$(cygpath -u "$WORKSPACE_PATH" 2>/dev/null)" || {
      log_error "FORGEWRIGHT_WORKSPACE cannot be normalized."
      exit 1
    }
  fi
  if [[ ! -d "$WORKSPACE_PATH" ]]; then
    log_error "FORGEWRIGHT_WORKSPACE is not a readable directory."
    exit 1
  fi
  PROJECT_ROOT="$(cd "$WORKSPACE_PATH" 2>/dev/null && pwd -P)" || {
    log_error "FORGEWRIGHT_WORKSPACE cannot be resolved."
    exit 1
  }
fi
cd "$PROJECT_ROOT"

TELEMETRY_DIR="${FORGEWRIGHT_TELEMETRY_DIR:-.forgewright/telemetry}"

HAS_JQ=0
command -v jq >/dev/null 2>&1 && HAS_JQ=1
PYTHON_BIN=""
if [[ "$HAS_JQ" -eq 0 ]]; then
  PYTHON_BIN="$(command -v python3 2>/dev/null || command -v python 2>/dev/null || true)"
  [[ -n "$PYTHON_BIN" ]] || { log_error "jq or python is required but not found in PATH."; exit 1; }
fi

ACTIVE_LOCK_DIR=""
_release_lock() {
  if [[ -n "$ACTIVE_LOCK_DIR" && -d "$ACTIVE_LOCK_DIR" ]]; then
    rmdir "$ACTIVE_LOCK_DIR" 2>/dev/null || true
  fi
  ACTIVE_LOCK_DIR=""
}

_append_locked() {
  local file="$1" record="$2" attempts=0 max_attempts=100
  mkdir -p "$(dirname "$file")"
  ACTIVE_LOCK_DIR="${file}.lock"
  while ! mkdir "$ACTIVE_LOCK_DIR" 2>/dev/null; do
    attempts=$((attempts + 1))
    if [[ "$attempts" -ge "$max_attempts" ]]; then
      log_error "Timed out waiting for telemetry append lock."
      ACTIVE_LOCK_DIR=""
      return 1
    fi
    sleep 0.02
  done
  trap _release_lock EXIT HUP INT TERM
  if ! printf '%s\n' "$record" >> "$file"; then
    _release_lock
    trap - EXIT HUP INT TERM
    return 1
  fi
  _release_lock
  trap - EXIT HUP INT TERM
}

usage() {
  cat >&2 <<'EOF'
Usage:
  telemetry.sh emit <event_type> <json_payload>   Append one event
  telemetry.sh report [YYYYMM]                    Aggregate one month (default: current UTC month)
EOF
  exit 1
}

cmd_emit() {
  [[ $# -eq 2 ]] || usage
  local event_type="$1" payload="$2"

  if [[ ! "$event_type" =~ ^[a-zA-Z0-9._-]+$ ]]; then
    log_error "Invalid event_type '${event_type}' (allowed: letters, digits, '.', '_', '-')."
    exit 1
  fi

  local ts month file record
  ts="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  month="$(date -u +'%Y%m')"
  file="${TELEMETRY_DIR}/events-${month}.jsonl"

  # jq validates and recursively redacts secret-bearing fields before either
  # persistence or stdout. Never echo the rejected payload on an error path.
  if [[ "$HAS_JQ" -eq 1 ]]; then
    if ! record="$(printf '%s' "$payload" \
      | jq -cse --arg ts "$ts" --arg event "$event_type" \
           'def redact:
              walk(
                if type == "object" then
                  with_entries(
                    if (.key | test("(^|[_-])(api[_-]?key|secret|token|password|auth|credential)([_-]|$)"; "i"))
                    then .value = "***REDACTED***"
                    else .
                    end
                  )
                else . end
              );
            if length != 1 or (.[0] | type) != "object" then
              error("payload must be exactly one JSON object")
            else
              {ts: $ts, event: $event, data: (.[0] | redact)}
            end' 2>/dev/null)"; then
      log_error "Payload must be exactly one valid JSON object."
      exit 1
    fi
  else
    if ! record="$("$PYTHON_BIN" - "$ts" "$event_type" "$payload" <<'PYEOF' 2>/dev/null
import json, re, sys
ts, event, raw = sys.argv[1], sys.argv[2], sys.argv[3]
secret_re = re.compile(r"(^|[_-])(api[_-]?key|secret|token|password|auth|credential)([_-]|$)", re.I)
def redact(v):
    if isinstance(v, dict):
        return {k: ("***REDACTED***" if secret_re.search(str(k)) else redact(val)) for k, val in v.items()}
    if isinstance(v, list):
        return [redact(x) for x in v]
    return v
dec = json.JSONDecoder()
s = raw.strip()
if not s:
    raise SystemExit(1)
obj, idx = dec.raw_decode(s)
if s[idx:].strip() or not isinstance(obj, dict):
    raise SystemExit(1)
print(json.dumps({"ts": ts, "event": event, "data": redact(obj)}, separators=(",", ":")))
PYEOF
    )"; then
      log_error "Payload must be exactly one valid JSON object."
      exit 1
    fi
  fi

  _append_locked "$file" "$record"
  printf '%s\n' "$record"
}

cmd_report() {
  local month="${1:-$(date -u +'%Y%m')}"
  if [[ ! "$month" =~ ^[0-9]{6}$ ]]; then
    log_error "Month must be YYYYMM, got: ${month}"
    exit 1
  fi

  local file="${TELEMETRY_DIR}/events-${month}.jsonl"
  if [[ ! -s "$file" ]]; then
    log_warn "No events recorded for ${month} (${file} missing or empty)."
    exit 0
  fi

  echo "── Telemetry report: ${month} ─────────────────────────────"
  echo "File:         ${file}"
  echo "Total events: $(wc -l < "$file" | tr -d ' ')"
  echo ""
  echo "By event type:"
  jq -r '.event' "$file" | sort | uniq -c | sort -rn \
    | awk '{printf "  %-32s %s\n", $2, $1}'
  echo ""
  echo "By day:"
  jq -r '.ts[0:10]' "$file" | sort | uniq -c \
    | awk '{printf "  %-12s %s\n", $2, $1}'
  echo ""
  echo "First event: $(jq -r '.ts' "$file" | sort | head -1)"
  echo "Last event:  $(jq -r '.ts' "$file" | sort | tail -1)"
}

[[ $# -ge 1 ]] || usage
cmd="$1"; shift
case "$cmd" in
  emit)   cmd_emit "$@" ;;
  report) cmd_report "$@" ;;
  *)      usage ;;
esac
