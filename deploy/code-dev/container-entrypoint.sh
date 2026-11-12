#!/bin/sh
# In-container supervisor entrypoint for the existing code-dev container.
#
# It validates the deployment, takes an exclusive flock, records the session
# leader PID and kernel start time in the durable state directory, and then
# replaces itself with the regular ticket-router worker. The host stop script
# signals this process group; the CLI remains responsible for cleaning up any
# agent/OpenCode processes it detached into other groups.
set -eu
umask 077

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
checkout=${ISSUE_ORCHESTRATOR_CHECKOUT:-$(CDPATH= cd "$script_dir/../.." && pwd)}
home=${ISSUE_ORCHESTRATOR_HOME:-}
[ -n "$home" ] || {
  echo 'issue-orchestrator-code-dev: ISSUE_ORCHESTRATOR_HOME is required' >&2
  exit 78
}
lock=${ISSUE_ORCHESTRATOR_LOCK_FILE:-$home/router.lock}
pidfile=${ISSUE_ORCHESTRATOR_PID_FILE:-$home/router.pid}
worker=${ISSUE_ORCHESTRATOR_WORKER:-$checkout/docker/worker.sh}

/bin/sh "$checkout/deploy/code-dev/check.sh"

# Keep fd 9 open across the setsid/exec below. flock releases the lock
# automatically when the worker process and its descendants have exited, so a
# stale PID file can never authorize a second concurrent router.
exec 9>>"$lock" || {
  echo "issue-orchestrator-code-dev: cannot open lock file: $lock" >&2
  exit 78
}
if ! flock -n 9; then
  echo "issue-orchestrator-code-dev: another router instance already holds $lock" >&2
  exit 75
fi

# setsid --wait creates a fresh session/process group. The child records its
# PID, kernel start time and a cmdline marker, then execs the worker with the
# same PID. The start time prevents a later PID reuse from being signalled.
exec setsid --wait /bin/sh -c '
  # issue-orchestrator-code-dev-session
  set -eu
  umask 077
  pidfile=$1
  shift
  fields=$(sed "s/^[0-9]* (.*) //" "/proc/$$/stat")
  starttime=$(printf "%s\n" "$fields" | awk "{print \$20}")
  case "$starttime" in
    ""|*[!0-9]*) echo "cannot read router start time" >&2; exit 1 ;;
  esac
  printf "%s %s\n" "$$" "$starttime" > "$pidfile.tmp"
  mv "$pidfile.tmp" "$pidfile"
  exec "$@"
' sh "$pidfile" /bin/sh "$worker"
