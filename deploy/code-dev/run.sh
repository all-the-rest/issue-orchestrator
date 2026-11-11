#!/bin/sh
# Host-side ExecStart wrapper for the existing code-dev container.
#
# The long-lived child is the docker exec client; systemd's ExecStop wrapper
# signals the router process group inside the container. Nothing here changes
# the container's lifecycle or configuration.
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
. "$script_dir/lib.sh"

require_workspace
command -v "$docker_bin" >/dev/null 2>&1 || die 69 "docker executable is not on PATH: $docker_bin"

echo "issue-orchestrator-code-dev: starting router in $container (mode=router, interval=${interval}s)"
container_exec /bin/sh "$entrypoint"
