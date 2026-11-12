#!/bin/sh
# Host-side preflight for the code-dev docker-exec deployment.
#
# It waits for the *existing* container to be running, never starts or restarts
# it, and then runs the read-only in-container check as the unprivileged user.
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
. "$script_dir/lib.sh"

unit_env=${ISSUE_ORCHESTRATOR_UNIT_ENV_FILE:-/etc/issue-orchestrator/code-dev.env}
if [ -e "$unit_env" ] || [ -L "$unit_env" ]; then
  require_root_private_file 'systemd environment file' "$unit_env"
fi

require_workspace
command -v "$docker_bin" >/dev/null 2>&1 || die 69 "docker executable is not on PATH: $docker_bin"

waited=0
while :; do
  if running=$("$docker_bin" inspect --format '{{.State.Running}}' "$container" 2>/dev/null) \
    && [ "$running" = true ]; then
    break
  fi
  if [ "$waited" -ge "$start_timeout" ]; then
    die 69 "container $container is not running after ${start_timeout}s; start it explicitly. This unit never starts, restarts, or recreates the container."
  fi
  sleep 2
  waited=$((waited + 2))
done

echo "issue-orchestrator-code-dev: container $container is running; validating the in-container deployment"
container_exec /bin/sh "$check_script"
echo "issue-orchestrator-code-dev: host preflight passed"
