#!/usr/bin/env bash
# scripts/lite/policy-check.sh
# Forgewright Phase 4 — execution policy gate.
# Reads .forgewright/execution-policy.yaml and checks tool arguments against
# deny_patterns. Designed to be called from guard middleware ④ before a tool
# call executes. See kernel/POLICY.md.
#
# Usage:
#   bash scripts/lite/policy-check.sh check <tool_name> [tool_args...]
#   bash scripts/lite/policy-check.sh get <key>
#   bash scripts/lite/policy-check.sh show
#
# Keys for `get`: mode | require_verify | max_escalations | refresh_interval_ticks
#
# Exit codes:
#   0 — ALLOW (also: audit-mode match)
#   1 — DENY  (pattern matched, mode=strict or unknown mode)
#   2 — WARN  (pattern matched, mode=permissive)
#   3 — usage error / missing dependency

set -euo pipefail

# Colors
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[POLICY]${NC} $*"; }
log_warn()  { echo -e "${YELLOW}[POLICY] WARNING:${NC} $*" >&2; }
log_error() { echo -e "${RED}[POLICY] ERROR:${NC} $*" >&2; }

# Find project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
if [[ -n "${FORGEWRIGHT_WORKSPACE:-}" ]]; then
  WORKSPACE_PATH="$FORGEWRIGHT_WORKSPACE"
  if command -v cygpath >/dev/null 2>&1; then
    NORMALIZED_WORKSPACE="$(cygpath -u "$WORKSPACE_PATH" 2>/dev/null)" || {
      log_error "FORGEWRIGHT_WORKSPACE cannot be normalized; DENY (fail-closed)."
      exit 1
    }
    WORKSPACE_PATH="$NORMALIZED_WORKSPACE"
  fi
  if [[ ! -d "$WORKSPACE_PATH" ]]; then
    log_error "FORGEWRIGHT_WORKSPACE is not a readable directory; DENY (fail-closed)."
    exit 1
  fi
  PROJECT_ROOT="$(cd "$WORKSPACE_PATH" 2>/dev/null && pwd -P)" || {
    log_error "FORGEWRIGHT_WORKSPACE cannot be resolved; DENY (fail-closed)."
    exit 1
  }
  FORGEWRIGHT_WORKSPACE="$PROJECT_ROOT"
  export FORGEWRIGHT_WORKSPACE
fi
cd "$PROJECT_ROOT"

POLICY_FILE="${FORGEWRIGHT_POLICY_FILE:-.forgewright/execution-policy.yaml}"
TELEMETRY_SH="${SCRIPT_DIR}/telemetry.sh"

PYTHON_COMMAND=()
_resolve_python() {
  [[ ${#PYTHON_COMMAND[@]} -gt 0 ]] && return 0
  if [[ -n "${FORGEWRIGHT_PYTHON_BIN:-}" && -x "${FORGEWRIGHT_PYTHON_BIN}" ]]; then
    PYTHON_COMMAND=("${FORGEWRIGHT_PYTHON_BIN}")
    return 0
  fi
  local candidate exe
  for candidate in python3 python python3.13 python3.12 python3.11; do
    exe="$(command -v "$candidate" 2>/dev/null || true)"
    if [[ -n "$exe" ]]; then
      PYTHON_COMMAND=("$exe")
      return 0
    fi
  done
  exe="$(command -v py.exe 2>/dev/null || command -v py 2>/dev/null || true)"
  if [[ -n "$exe" ]]; then
    PYTHON_COMMAND=("$exe" "-3")
    return 0
  fi
  log_error "python3/python is required but not found in PATH."
  exit 3
}

usage() {
  cat >&2 <<'EOF'
Usage:
  policy-check.sh check <tool_name> [tool_args...]   Gate a tool call
  policy-check.sh get <key>                          Read one policy scalar
  policy-check.sh show                               Dump effective policy
EOF
  exit 3
}

# Best-effort telemetry — must never fail the gate.
_emit() {
  [[ -f "$TELEMETRY_SH" ]] || return 0
  bash "$TELEMETRY_SH" emit "$1" "$2" >/dev/null 2>&1 || true
}

POLICY_MODE=""
POLICY_REQUIRE_VERIFY=""
POLICY_MAX_ESCALATIONS=""
POLICY_REFRESH_TICKS=""
POLICY_PATTERNS=()

# Extract a scalar value: `key: value   # comment` → `value`.
# Values must not contain spaces (documented in the policy file header).
_scalar() {
  case "$1" in
    mode)                    printf '%s\n' "$POLICY_MODE" ;;
    require_verify)          printf '%s\n' "$POLICY_REQUIRE_VERIFY" ;;
    max_escalations)         printf '%s\n' "$POLICY_MAX_ESCALATIONS" ;;
    refresh_interval_ticks)  printf '%s\n' "$POLICY_REFRESH_TICKS" ;;
    *)                       printf '\n' ;;
  esac
}

# Extract deny_patterns list items: `  - "pattern"` → `pattern`.
# deny_patterns is the only list in this file, so any `- ` line belongs to it.
_deny_patterns() {
  local p
  for p in "${POLICY_PATTERNS[@]}"; do
    printf '%s\n' "$p"
  done
}

_policy_error() {
  log_error "Execution policy is missing, unreadable, empty, or malformed; DENY (fail-closed)."
  return 1
}

_validate_policy() {
  [[ -f "$POLICY_FILE" && -r "$POLICY_FILE" && -s "$POLICY_FILE" ]] || return 1

  POLICY_MODE=""
  POLICY_REQUIRE_VERIFY=""
  POLICY_MAX_ESCALATIONS=""
  POLICY_REFRESH_TICKS=""
  POLICY_PATTERNS=()

  local line pattern_count=0
  local c_mode=0 c_rv=0 c_me=0 c_rt=0 c_dp=0
  local scalar_re='^(mode|require_verify|max_escalations|refresh_interval_ticks):[[:space:]]*([^[:space:]#"]+)([[:space:]]*#.*)?$'
  local item_re='^[[:space:]]*-[[:space:]]"([^"]+)"[[:space:]]*$'

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    if [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]]; then
      continue
    fi
    case "$line" in
      mode:*|require_verify:*|max_escalations:*|refresh_interval_ticks:*)
        [[ "$line" =~ $scalar_re ]] || return 1
        case "${BASH_REMATCH[1]}" in
          mode)
            c_mode=$((c_mode + 1))
            POLICY_MODE="${BASH_REMATCH[2]}"
            ;;
          require_verify)
            c_rv=$((c_rv + 1))
            POLICY_REQUIRE_VERIFY="${BASH_REMATCH[2]}"
            ;;
          max_escalations)
            c_me=$((c_me + 1))
            POLICY_MAX_ESCALATIONS="${BASH_REMATCH[2]}"
            ;;
          refresh_interval_ticks)
            c_rt=$((c_rt + 1))
            POLICY_REFRESH_TICKS="${BASH_REMATCH[2]}"
            ;;
        esac
        ;;
      deny_patterns:*)
        [[ "$line" =~ ^deny_patterns:[[:space:]]*$ ]] || return 1
        c_dp=$((c_dp + 1))
        ;;
      [[:space:]]*'- '*)
        [[ "$line" =~ $item_re ]] || return 1
        POLICY_PATTERNS+=("${BASH_REMATCH[1]}")
        pattern_count=$((pattern_count + 1))
        ;;
      *) return 1 ;;
    esac
  done < "$POLICY_FILE"

  [[ "$c_mode" -eq 1 && "$c_rv" -eq 1 && "$c_me" -eq 1 && "$c_rt" -eq 1 && "$c_dp" -eq 1 ]] || return 1

  local regex_rc pattern
  for pattern in "${POLICY_PATTERNS[@]}"; do
    regex_rc=0
    # shellcheck disable=SC2319
    [[ "" =~ $pattern ]] 2>/dev/null || regex_rc=$?
    [[ "$regex_rc" -le 1 ]] || return 1
  done

  [[ "$POLICY_MODE" =~ ^(strict|permissive|audit)$ ]] || return 1
  [[ "$POLICY_REQUIRE_VERIFY" =~ ^(true|false)$ ]] || return 1
  [[ "$POLICY_MAX_ESCALATIONS" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ "$POLICY_REFRESH_TICKS" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ "$pattern_count" -gt 0 ]] || return 1
}

# Detect destructive commands structurally so wrappers, executable paths, git
# global options, and split short flags cannot bypass the configurable regexes.
_builtin_deny() {
  _resolve_python
  "${PYTHON_COMMAND[@]}" - "$1" <<'PYEOF'
import os
import shlex
import sys

subject = sys.argv[1]
try:
    lexer = shlex.shlex(subject.replace("\\", "/"), posix=True, punctuation_chars=";&|")
    lexer.whitespace_split = True
    tokens = list(lexer)
except ValueError:
    print("malformed-command")
    raise SystemExit(0)

stops = {";", "&&", "||", "|", "&"}

def base(token: str) -> str:
    name = token.replace("\\", "/").rsplit("/", 1)[-1].lower()
    for ext in (".exe", ".cmd", ".bat"):
        if name.endswith(ext):
            return name[: -len(ext)]
    return name

for i, token in enumerate(tokens):
    command = base(token)
    segment = []
    for item in tokens[i + 1 :]:
        if item in stops:
            break
        segment.append(item)

    if command == "rm":
        flags = ""
        long_flags = set()
        for arg in segment:
            if arg.startswith("--"):
                long_flags.add(arg)
            elif arg.startswith("-"):
                flags += arg[1:]
        recursive = "r" in flags or "R" in flags or "--recursive" in long_flags
        force = "f" in flags or "--force" in long_flags
        if recursive and force:
            print("builtin:rm-recursive-force")
            raise SystemExit(0)

    if command == "git":
        j = 0
        options_with_value = {"-C", "-c", "--git-dir", "--work-tree", "--namespace"}
        while j < len(segment):
            arg = segment[j]
            if arg in options_with_value:
                j += 2
                continue
            if any(arg.startswith(prefix + "=") for prefix in options_with_value if prefix.startswith("--")):
                j += 1
                continue
            if arg == "--":
                j += 1
                break
            if arg.startswith("-"):
                j += 1
                continue
            break
        args = segment[j:]
        if args[:1] == ["reset"] and "--hard" in args[1:]:
            print("builtin:git-reset-hard")
            raise SystemExit(0)
        if args[:1] == ["clean"] and any(
            arg == "--force" or (arg.startswith("-") and "f" in arg[1:]) for arg in args[1:]
        ):
            print("builtin:git-clean-force")
            raise SystemExit(0)
        if args[:1] == ["push"] and any(
            arg in {"--force", "-f"} or arg.startswith("--force=") for arg in args[1:]
        ):
            print("builtin:git-push-force")
            raise SystemExit(0)

    if command == "chmod" and "777" in segment:
        print("builtin:chmod-777")
        raise SystemExit(0)

print("")
PYEOF
}

_default_for() {
  case "$1" in
    mode)                    echo "strict" ;;
    require_verify)          echo "true" ;;
    max_escalations)         echo "3" ;;
    refresh_interval_ticks)  echo "10" ;;
    *)                       echo "" ;;
  esac
}

cmd_get() {
  [[ $# -eq 1 ]] || usage
  _validate_policy || { _policy_error; exit 1; }
  local key="$1"
  local default
  default="$(_default_for "$key")"
  if [[ -z "$default" ]]; then
    log_error "Unknown policy key: ${key}"
    exit 3
  fi
  local value
  value="$(_scalar "$key")"
  echo "${value:-$default}"
}

cmd_show() {
  _validate_policy || { _policy_error; exit 1; }
  echo "── Effective execution policy ─────────────────────────────"
  echo "File: ${POLICY_FILE} $([[ -f "$POLICY_FILE" ]] && echo '(present)' || echo '(MISSING — built-in defaults)')"
  local key
  for key in mode require_verify max_escalations refresh_interval_ticks; do
    printf "  %-24s %s\n" "$key" "$(cmd_get "$key")"
  done
  echo "  deny_patterns:"
  _deny_patterns | while IFS= read -r p; do
    [[ -n "$p" ]] && printf "    - %s\n" "$p"
  done
}

cmd_check() {
  [[ $# -ge 1 ]] || usage
  local tool="$1"
  shift
  local args="$*"
  local subject="${tool} ${args}"

  _validate_policy || { _policy_error; exit 1; }

  local mode
  mode="${POLICY_MODE:-strict}"

  local matched=""
  local builtin_re='(^|[^a-zA-Z0-9_])(rm|git|chmod)([^a-zA-Z0-9_]|$)'
  if [[ "$subject" == *"'"* || "$subject" == *'"'* || "$subject" == *"\\"* || "$subject" =~ $builtin_re ]]; then
    matched="$(_builtin_deny "$subject")"
  fi
  local pattern
  shopt -s nocasematch
  for pattern in "${POLICY_PATTERNS[@]}"; do
    [[ -n "$matched" ]] && break
    [[ -z "$pattern" ]] && continue
    if [[ "$subject" =~ $pattern ]]; then
      matched="$pattern"
      break
    fi
  done
  shopt -u nocasematch

  if [[ -z "$matched" ]]; then
    log_info "ALLOW ${tool}"
    exit 0
  fi

  local payload
  if command -v jq >/dev/null 2>&1; then
    payload="$(jq -cn --arg tool "$tool" --arg pattern "$matched" --arg mode "$mode" \
                      '{tool: $tool, pattern: $pattern, mode: $mode}')"
  else
    _resolve_python
    payload="$("${PYTHON_COMMAND[@]}" -c 'import json,sys; print(json.dumps({"tool":sys.argv[1],"pattern":sys.argv[2],"mode":sys.argv[3]},separators=(",",":")))' "$tool" "$matched" "$mode")"
  fi

  case "$mode" in
    permissive)
      _emit "policy.warn" "$payload"
      log_warn "WARN ${tool}: args match deny pattern [${matched}] — allowed (mode=permissive)."
      exit 2
      ;;
    audit)
      _emit "policy.audit" "$payload"
      log_info "AUDIT ${tool}: args match deny pattern [${matched}] — logged only (mode=audit)."
      exit 0
      ;;
    strict|*)
      # Unknown modes fail closed.
      _emit "policy.deny" "$payload"
      log_error "DENY ${tool}: args match deny pattern [${matched}] (mode=${mode})."
      exit 1
      ;;
  esac
}

[[ $# -ge 1 ]] || usage
cmd="$1"; shift
case "$cmd" in
  check) cmd_check "$@" ;;
  get)   cmd_get "$@" ;;
  show)  cmd_show "$@" ;;
  *)     usage ;;
esac
