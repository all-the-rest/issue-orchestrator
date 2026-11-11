#!/bin/sh
# Host-side ExecStop wrapper for the code-dev docker-exec deployment.
#
# Killing a docker exec client does not signal the process inside the
# container. This wrapper delegates to the in-container stop script, which
# verifies the recorded PID/start time/identity, sends SIGTERM to the router's
# own process group, and fails closed on timeout instead of blindly SIGKILLing
# detached agent sessions. It never stops, restarts, recreates or reconfigures
# the container.
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
. "$script_dir/lib.sh"

stop_script=${ISSUE_ORCHESTRATOR_STOP_SCRIPT:-$checkout/deploy/code-dev/stop-container.sh}

command -v "$docker_bin" >/dev/null 2>&1 || {
  echo 'issue-orchestrator-code-dev: docker is unavailable; nothing to signal'
  exit 0
}

if ! running=$("$docker_bin" inspect --format '{{.State.Running}}' "$container" 2>/dev/null) \
  || [ "$running" != true ]; then
  echo "issue-orchestrator-code-dev: container $container is not running; nothing to signal"
  exit 0
fi

container_exec /bin/sh "$stop_script" "$state_dir/router.pid" "$stop_timeout" "$worker" "$entrypoint"
