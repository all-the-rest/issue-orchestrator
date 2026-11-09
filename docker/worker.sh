#!/bin/sh
set -u
interval=${ISSUE_ORCHESTRATOR_INTERVAL_SECONDS:-300}
case "$interval" in
  ''|*[!0-9]*) echo 'ISSUE_ORCHESTRATOR_INTERVAL_SECONDS must be an integer >= 60' >&2; exit 64 ;;
esac
if [ "${#interval}" -gt 6 ] || [ "$interval" -lt 60 ]; then
  echo 'ISSUE_ORCHESTRATOR_INTERVAL_SECONDS must be an integer >= 60 (maximum 999999)' >&2
  exit 64
fi
repo=${ISSUE_ORCHESTRATOR_REPO:-$PWD}
if [ ! -d "$repo/.git" ] && [ ! -f "$repo/.git" ]; then
  echo "ISSUE_ORCHESTRATOR_REPO is not a Git checkout: $repo" >&2
  exit 64
fi
cd "$repo"
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
while :; do
  cd "$repo"
  node /opt/issue-orchestrator/dist/cli.js run --once &
  child=$!
  wait "$child" || true
  child=
  [ "$stopping" -eq 1 ] && exit 0
  # A transient refusal must not become a hot restart loop.
  sleep "$interval" &
  child=$!
  wait "$child" || true
  child=
  [ "$stopping" -eq 1 ] && exit 0
done
