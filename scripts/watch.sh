#!/usr/bin/env bash
# Live view of claudefish activity. Tails log + journal + sessions JSONL in one terminal.
#
# Usage:
#   scripts/watch.sh          # all three streams
#   scripts/watch.sh log      # just the stdout log
#   scripts/watch.sh journal  # just today's journal
#   scripts/watch.sh json     # just today's session JSONL (pretty-printed if jq present)

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$ROOT/data"
DAY="$(date +%Y-%m-%d)"

LOG="$DATA/claudefish.log"
ERR="$DATA/claudefish.err.log"
JOURNAL="$DATA/journal/${DAY}.md"
SESSION="$DATA/sessions/${DAY}.jsonl"

CYAN=$'\033[36m'
YELLOW=$'\033[33m'
MAGENTA=$'\033[35m'
RED=$'\033[31m'
DIM=$'\033[2m'
RESET=$'\033[0m'

has_jq() { command -v jq >/dev/null 2>&1; }

ensure() {
  mkdir -p "$DATA/journal" "$DATA/sessions"
  [ -f "$LOG" ]     || : > "$LOG"
  [ -f "$ERR" ]     || : > "$ERR"
  [ -f "$JOURNAL" ] || : > "$JOURNAL"
  [ -f "$SESSION" ] || : > "$SESSION"
}

tail_log() {
  tail -n 20 -F "$LOG" "$ERR" 2>/dev/null | while IFS= read -r line; do
    printf '%s[log]%s %s\n' "$CYAN" "$RESET" "$line"
  done
}

tail_journal() {
  tail -n 40 -F "$JOURNAL" 2>/dev/null | while IFS= read -r line; do
    printf '%s[journal]%s %s\n' "$YELLOW" "$RESET" "$line"
  done
}

tail_json() {
  if has_jq; then
    tail -n 20 -F "$SESSION" 2>/dev/null | while IFS= read -r line; do
      [ -z "$line" ] && continue
      pretty=$(printf '%s' "$line" | jq -rc '
        if .type == "tool" then "\(.name) \(.input // {} | tostring | .[0:120])\(if .isError then "  [ERR]" else "" end)"
        elif .type == "reply" then "reply chars=\(.chars) model=\(.model) profile=\(.profile)"
        elif .type == "api_error" then "API ERROR: \(.error)"
        else tostring end' 2>/dev/null)
      [ -z "$pretty" ] && pretty="$line"
      printf '%s[turn]%s %s\n' "$MAGENTA" "$RESET" "$pretty"
    done
  else
    tail -n 20 -F "$SESSION" 2>/dev/null | while IFS= read -r line; do
      printf '%s[turn]%s %s\n' "$MAGENTA" "$RESET" "$line"
    done
  fi
}

cleanup() {
  [ -n "${PIDS:-}" ] && kill $PIDS 2>/dev/null
  exit 0
}
trap cleanup INT TERM

ensure

MODE="${1:-all}"

case "$MODE" in
  log)     tail_log ;;
  journal) tail_journal ;;
  json)    tail_json ;;
  all|"")
    printf '%s▸ watching claudefish%s  log=%s journal=%s session=%s%s\n\n' \
      "$DIM" "$RESET" "$LOG" "$JOURNAL" "$SESSION" ""
    has_jq || printf '%s(tip: brew install jq for prettier session view)%s\n\n' "$DIM" "$RESET"
    tail_log & PIDS="$!"
    tail_journal & PIDS="$PIDS $!"
    tail_json & PIDS="$PIDS $!"
    wait
    ;;
  *)
    printf '%sunknown mode:%s %s\nusage: watch.sh [all|log|journal|json]\n' "$RED" "$RESET" "$MODE" >&2
    exit 1
    ;;
esac
