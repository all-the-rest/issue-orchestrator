#!/bin/sh
# Container entrypoint for the persistent ticket router (default) and the
# retained legacy one-shot builder loop (ISSUE_ORCHESTRATOR_MODE=builder).
#
# The script validates its deployment inputs before starting, forwards
# SIGTERM/SIGINT to the active CLI process, and paces restarts so a refused
# run cannot become a hot loop. It never prints credential contents.
set -u
umask 077

usage() {
  echo 'usage: issue-orchestrator-worker [--once]' >&2
  exit 64
}

die() {
  code=$1
  shift
  echo "issue-orchestrator-worker: $*" >&2
  exit "$code"
}

once=0
for arg in "$@"; do
  case "$arg" in
    --once) once=1 ;;
    *) usage ;;
  esac
done

mode=${ISSUE_ORCHESTRATOR_MODE:-router}
case "$mode" in
  router|builder) ;;
  *) die 64 'ISSUE_ORCHESTRATOR_MODE must be "router" or "builder"' ;;
esac

interval=${ISSUE_ORCHESTRATOR_INTERVAL_SECONDS:-300}
case "$interval" in
  ''|*[!0-9]*) echo 'ISSUE_ORCHESTRATOR_INTERVAL_SECONDS must be an integer >= 60' >&2; exit 64 ;;
esac
if [ "${#interval}" -gt 6 ] || [ "$interval" -lt 60 ]; then
  echo 'ISSUE_ORCHESTRATOR_INTERVAL_SECONDS must be an integer >= 60 (maximum 999999)' >&2
  exit 64
fi

project=${ISSUE_ORCHESTRATOR_PROJECT:-}
if [ -n "$project" ]; then
  case "$project" in
    */*) project_owner=${project%%/*}; project_name=${project#*/} ;;
    *) die 64 'ISSUE_ORCHESTRATOR_PROJECT must be owner/repository' ;;
  esac
  case "$project_name" in */*) die 64 'ISSUE_ORCHESTRATOR_PROJECT must be owner/repository' ;; esac
  case "$project_owner" in ''|*[!A-Za-z0-9_.-]*|[!A-Za-z0-9]*) die 64 'ISSUE_ORCHESTRATOR_PROJECT must be owner/repository' ;; esac
  case "$project_name" in ''|*[!A-Za-z0-9_.-]*|[!A-Za-z0-9]*) die 64 'ISSUE_ORCHESTRATOR_PROJECT must be owner/repository' ;; esac
fi

max=${ISSUE_ORCHESTRATOR_MAX:-}
if [ -n "$max" ]; then
  case "$max" in
    ''|*[!0-9]*) die 64 'ISSUE_ORCHESTRATOR_MAX must be an integer from 1 to 1000' ;;
  esac
  if [ "${#max}" -gt 4 ] || [ "$max" -lt 1 ] || [ "$max" -gt 1000 ]; then
    die 64 'ISSUE_ORCHESTRATOR_MAX must be an integer from 1 to 1000'
  fi
fi

repo=${ISSUE_ORCHESTRATOR_REPO:-$PWD}
if [ ! -d "$repo/.git" ] && [ ! -f "$repo/.git" ]; then
  echo "ISSUE_ORCHESTRATOR_REPO is not a Git checkout: $repo" >&2
  exit 64
fi

node_bin=${ISSUE_ORCHESTRATOR_NODE_BIN:-node}
cli=${ISSUE_ORCHESTRATOR_CLI:-/opt/issue-orchestrator/dist/cli.js}
case "$cli" in
  /*) ;;
  *) die 64 'ISSUE_ORCHESTRATOR_CLI must be an absolute path' ;;
esac
[ -f "$cli" ] && [ -r "$cli" ] || die 78 "ISSUE_ORCHESTRATOR_CLI is not a readable file: $cli"
command -v "$node_bin" >/dev/null 2>&1 || die 69 "required executable ${node_bin} is not on PATH"

if stat -c %u / >/dev/null 2>&1; then
  stat_uid() { stat -c %u "$1"; }
  stat_mode() { stat -c %a "$1"; }
else
  stat_uid() { stat -f %u "$1"; }
  stat_mode() { stat -f %Lp "$1"; }
fi
current_uid=$(id -u)

require_regular() {
  [ -f "$2" ] && [ ! -L "$2" ] || die 78 "$1 must be a readable regular file"
  [ -r "$2" ] || die 78 "$1 is not readable"
}

require_private_file() {
  require_regular "$1" "$2"
  [ "$(stat_uid "$2")" = "$current_uid" ] || die 78 "$1 must be owned by the worker UID"
  require_found=$(stat_mode "$2")
  case "$require_found" in
    400|600|0400|0600) ;;
    *) die 78 "$1 must be mode 0600 or 0400 (found $require_found), not group/other accessible" ;;
  esac
}

require_private_dir() {
  [ -d "$2" ] && [ ! -L "$2" ] || die 78 "$1 must be a real directory"
  [ -r "$2" ] && [ -x "$2" ] || die 78 "$1 is not readable and searchable"
  [ "$(stat_uid "$2")" = "$current_uid" ] || die 78 "$1 must be owned by the worker UID"
  require_found=$(stat_mode "$2")
  case "$require_found" in
    700|750|755|500|550|555|0700|0750|0755|0500|0550|0555) ;;
    *) die 78 "$1 must not be group/other writable (mode 0700 recommended; found $require_found)" ;;
  esac
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die 69 "required executable $1 is not on PATH"
}

if [ "$mode" = router ]; then
  home=${HOME:-/home/node}
  config=${ISSUE_ORCHESTRATOR_CONFIG:-${ISSUE_ORCHESTRATOR_HOME:-$home/.config/issue-orchestrator}/config.jsonc}
  gh_dir=${GH_CONFIG_DIR:-${XDG_CONFIG_HOME:-$home/.config}/gh}
  opencode_config_dir=${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$home/.config}/opencode}
  opencode_data=${XDG_DATA_HOME:-$home/.local/share}/opencode
  require_regular 'Issue Orchestrator config' "$config"
  require_private_dir 'GitHub CLI credential directory' "$gh_dir"
  require_private_file 'GitHub CLI hosts.yml' "$gh_dir/hosts.yml"
  require_private_dir 'OpenCode data directory' "$opencode_data"
  if [ -e "$opencode_data/auth.json" ] || [ -L "$opencode_data/auth.json" ]; then
    require_private_file 'OpenCode auth.json' "$opencode_data/auth.json"
  fi
  if [ -n "${OPENCODE_CONFIG:-}" ]; then
    require_regular 'OpenCode config' "$OPENCODE_CONFIG"
  else
    opencode_config=
    for candidate in "$opencode_config_dir/opencode.jsonc" "$opencode_config_dir/opencode.json"; do
      if [ -f "$candidate" ] && [ -r "$candidate" ]; then
        opencode_config=$candidate
        break
      fi
    done
    [ -n "$opencode_config" ] || die 78 'OpenCode config is missing; mount opencode.jsonc or set OPENCODE_CONFIG'
  fi
  require_command git
  require_command gh
  require_command opencode
fi

if [ "$mode" = router ]; then
  set -- "$cli" tickets poll
  [ -n "$project" ] && set -- "$@" --project "$project"
  [ -n "$max" ] && set -- "$@" --max "$max"
else
  set -- "$cli" run --once
  [ -n "$project" ] && set -- "$@" --project "$project"
fi

child=
stopping=0
stop() {
  stopping=1
  if [ -n "$child" ]; then
    kill -TERM "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
}
trap stop TERM INT

printf 'issue-orchestrator-worker: mode=%s interval=%ss\n' "$mode" "$interval"
while :; do
  [ "$stopping" -eq 1 ] && exit 0
  cd "$repo" || die 78 "cannot change to ISSUE_ORCHESTRATOR_REPO: $repo"
  "$node_bin" "$@" &
  child=$!
  status=0
  wait "$child" || status=$?
  child=
  [ "$stopping" -eq 1 ] && exit 0
  if [ "$once" -eq 1 ]; then
    exit "$status"
  fi
  if [ "$status" -ne 0 ]; then
    echo "issue-orchestrator-worker: $mode cycle failed with status $status; retrying in ${interval}s" >&2
  fi
  # A transient refusal must not become a hot restart loop.
  sleep "$interval" &
  child=$!
  wait "$child" || true
  child=
  [ "$stopping" -eq 1 ] && exit 0
done
