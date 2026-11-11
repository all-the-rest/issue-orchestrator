#!/bin/sh
# In-container stop logic for the existing code-dev deployment.
#
# The PID file records "<pid> <starttime>" so a reused PID is never mistaken
# for the router. The process is only signalled after its start time, session
# leader identity, process group and cmdline all match. On timeout this script
# deliberately does NOT send SIGKILL: detached agent supervisors are not part
# of the supervisor's process-group guarantee, and a blind group kill can leave
# an agent session half-dead. It fails closed and leaves the PID file for
# operator inspection instead.
#
# Arguments: <pid-file> <timeout-seconds> <worker-path> <entrypoint-path>
set -u

pidfile=$1
timeout=$2
worker=$3
entrypoint=$4
marker=issue-orchestrator-code-dev-session
proc_root=${ISSUE_ORCHESTRATOR_PROC_ROOT:-/proc}

case "$timeout" in
  ''|*[!0-9]*) echo 'invalid stop timeout' >&2; exit 64 ;;
esac

if [ ! -e "$pidfile" ]; then
  echo 'router pid file is missing; refusing to report a successful stop' >&2
  exit 1
fi

read -r pid starttime extra < "$pidfile" || {
  echo 'cannot read router pid file; refusing to report a successful stop' >&2
  exit 1
}
case "$pid" in
  ''|*[!0-9]*) echo 'invalid router pid; refusing to signal' >&2; exit 1 ;;
esac
case "$starttime" in
  ''|*[!0-9]*) echo 'invalid router start time; refusing to signal' >&2; exit 1 ;;
esac
[ "$pid" -gt 1 ] || { echo 'unsafe router pid; refusing to signal' >&2; exit 1; }

stat_file=$proc_root/$pid/stat
if [ ! -r "$stat_file" ]; then
  echo "router pid $pid is not running; removing stale pid file"
  rm -f "$pidfile"
  exit 0
fi

fields=$(sed "s/^[0-9]* (.*) //" "$stat_file")
actual_start=$(printf "%s\n" "$fields" | awk "{print \$20}")
pgrp=$(printf "%s\n" "$fields" | awk "{print \$3}")
session=$(printf "%s\n" "$fields" | awk "{print \$4}")

if [ "$actual_start" != "$starttime" ]; then
  echo "router pid $pid was reused (start time mismatch); removing stale pid file without signalling"
  rm -f "$pidfile"
  exit 0
fi
if [ "$pgrp" != "$pid" ] || [ "$session" != "$pid" ]; then
  echo "refusing to signal pid $pid: it is not the recorded router session leader" >&2
  exit 1
fi

cmdline=$(tr '\0' ' ' < "$proc_root/$pid/cmdline" 2>/dev/null || true)
case "$cmdline" in
  *"$worker"*|*"$entrypoint"*|*"$marker"*) ;;
  *)
    echo "refusing to signal pid $pid: cmdline does not identify the router" >&2
    exit 1
    ;;
esac

kill -TERM "-$pid" 2>/dev/null || true

waited=0
while :; do
  alive=0
  for stat in "$proc_root"/[0-9]*/stat; do
    [ -r "$stat" ] || continue
    fields=$(sed "s/^[0-9]* (.*) //" "$stat")
    state=$(printf "%s\n" "$fields" | awk "{print \$1}")
    group=$(printf "%s\n" "$fields" | awk "{print \$3}")
    if [ "$group" = "$pid" ] && [ "$state" != Z ]; then
      alive=1
      break
    fi
  done
  [ "$alive" -eq 0 ] && break
  if [ "$waited" -ge "$timeout" ]; then
    echo "router process group $pid did not stop within ${timeout}s; refusing SIGKILL because detached agent sessions are not part of this group" >&2
    exit 1
  fi
  sleep 1
  waited=$((waited + 1))
done

rm -f "$pidfile"
echo "router process group $pid stopped"
exit 0
