#!/bin/sh
# Shared host-side settings for running the orchestrator inside an existing
# code-dev container. This file is sourced by the host wrappers below; it is
# never executed inside the container.
#
# Every path in this file is a path inside the container. The matching host
# path is provided by the container's existing bind mount (for example
# /srv/dev-projects -> /projects); this deployment does not add mounts.
# No credentials belong here or in the environment file.

die() {
  code=$1
  shift
  echo "issue-orchestrator-code-dev: $*" >&2
  exit "$code"
}

if stat -c %u / >/dev/null 2>&1; then
  host_stat_uid() { stat -c %u "$1"; }
  host_stat_mode() { stat -c %a "$1"; }
else
  host_stat_uid() { stat -f %u "$1"; }
  host_stat_mode() { stat -f %Lp "$1"; }
fi

require_root_private_file() {
  label=$1
  file=$2
  [ -f "$file" ] && [ ! -L "$file" ] || die 78 "$label must be a regular non-symlink file: $file"
  [ "$(host_stat_uid "$file")" = 0 ] || die 78 "$label must be root-owned: $file"
  found=$(host_stat_mode "$file")
  case "$found" in
    400|600|0400|0600) ;;
    *) die 78 "$label must be mode 0600 or 0400 (found $found): $file" ;;
  esac
}

# Optional manual-invocation convenience: read the same root-owned env file the
# systemd unit uses. Never source a user-writable file as root.
if [ -n "${ISSUE_ORCHESTRATOR_ENV_FILE:-}" ]; then
  require_root_private_file 'environment file' "$ISSUE_ORCHESTRATOR_ENV_FILE"
  set -a
  # shellcheck disable=SC1090
  . "$ISSUE_ORCHESTRATOR_ENV_FILE"
  set +a
fi

container=${ISSUE_ORCHESTRATOR_CONTAINER:-code-dev}
container_user=${ISSUE_ORCHESTRATOR_CONTAINER_USER:-dev}
checkout=${ISSUE_ORCHESTRATOR_CHECKOUT:-/projects/issue-orchestrator}
workspace=${ISSUE_ORCHESTRATOR_WORKSPACE:-}
state_dir=${ISSUE_ORCHESTRATOR_STATE_DIR:-/home/dev/.local/state/opencode/issue-orchestrator}
config=${ISSUE_ORCHESTRATOR_CONFIG:-}
if [ -z "$config" ]; then
  config=$state_dir/config.jsonc
fi
interval=${ISSUE_ORCHESTRATOR_INTERVAL_SECONDS:-300}
max=${ISSUE_ORCHESTRATOR_MAX:-1000}
project=${ISSUE_ORCHESTRATOR_PROJECT:-}
gh_config_dir=${ISSUE_ORCHESTRATOR_GH_CONFIG_DIR:-/home/dev/.config/gh}
opencode_config=${ISSUE_ORCHESTRATOR_OPENCODE_CONFIG:-/home/dev/.config/opencode/opencode.jsonc}
opencode_data_dir=${ISSUE_ORCHESTRATOR_OPENCODE_DATA_DIR:-/home/dev/.local/share/opencode}
legacy_home=${ISSUE_ORCHESTRATOR_LEGACY_HOME:-/home/dev/.config/issue-orchestrator}
legacy_config=${ISSUE_ORCHESTRATOR_LEGACY_CONFIG:-$legacy_home/config.jsonc}
state_decision=${ISSUE_ORCHESTRATOR_STATE_DECISION:-}
start_timeout=${ISSUE_ORCHESTRATOR_START_TIMEOUT_SECONDS:-180}
stop_timeout=${ISSUE_ORCHESTRATOR_STOP_TIMEOUT_SECONDS:-300}
entrypoint=${ISSUE_ORCHESTRATOR_ENTRYPOINT:-$checkout/deploy/code-dev/container-entrypoint.sh}
check_script=${ISSUE_ORCHESTRATOR_CHECK:-$checkout/deploy/code-dev/check.sh}
worker=${ISSUE_ORCHESTRATOR_WORKER:-$checkout/docker/worker.sh}
docker_bin=${ISSUE_ORCHESTRATOR_DOCKER:-docker}

require_nonempty() {
  [ -n "$2" ] || die 64 "$1 must not be empty"
}

require_absolute() {
  case "$2" in
    /*) ;;
    *) die 64 "$1 must be an absolute container path" ;;
  esac
}

require_integer() {
  case "$2" in
    ''|*[!0-9]*) die 64 "$1 must be an integer" ;;
  esac
}

require_workspace() {
  require_nonempty ISSUE_ORCHESTRATOR_WORKSPACE "$workspace"
  require_absolute ISSUE_ORCHESTRATOR_WORKSPACE "$workspace"
}

require_nonempty ISSUE_ORCHESTRATOR_CONTAINER "$container"
require_nonempty ISSUE_ORCHESTRATOR_CONTAINER_USER "$container_user"
require_absolute ISSUE_ORCHESTRATOR_CHECKOUT "$checkout"
require_absolute ISSUE_ORCHESTRATOR_STATE_DIR "$state_dir"
require_absolute ISSUE_ORCHESTRATOR_CONFIG "$config"
require_absolute ISSUE_ORCHESTRATOR_GH_CONFIG_DIR "$gh_config_dir"
require_absolute ISSUE_ORCHESTRATOR_OPENCODE_CONFIG "$opencode_config"
require_absolute ISSUE_ORCHESTRATOR_OPENCODE_DATA_DIR "$opencode_data_dir"
require_integer ISSUE_ORCHESTRATOR_INTERVAL_SECONDS "$interval"
require_integer ISSUE_ORCHESTRATOR_MAX "$max"
require_integer ISSUE_ORCHESTRATOR_START_TIMEOUT_SECONDS "$start_timeout"
require_integer ISSUE_ORCHESTRATOR_STOP_TIMEOUT_SECONDS "$stop_timeout"
case "$state_decision" in
  ''|migrated|fresh) ;;
  *) die 64 'ISSUE_ORCHESTRATOR_STATE_DECISION must be "migrated" or "fresh" when set' ;;
esac

if [ "${#interval}" -gt 6 ] || [ "$interval" -lt 60 ] || [ "$interval" -gt 999999 ]; then
  die 64 'ISSUE_ORCHESTRATOR_INTERVAL_SECONDS must be an integer from 60 to 999999'
fi
if [ "${#max}" -gt 4 ] || [ "$max" -lt 1 ] || [ "$max" -gt 1000 ]; then
  die 64 'ISSUE_ORCHESTRATOR_MAX must be an integer from 1 to 1000'
fi

# Run a fixed command in the existing container as the unprivileged container
# user. The caller supplies the command; this helper adds only non-secret paths
# and routing limits.
container_exec() {
  "$docker_bin" exec --user "$container_user" --workdir "$checkout" \
    --env "ISSUE_ORCHESTRATOR_HOME=$state_dir" \
    --env "ISSUE_ORCHESTRATOR_CONFIG=$config" \
    --env "ISSUE_ORCHESTRATOR_REPO=$workspace" \
    --env "ISSUE_ORCHESTRATOR_CLI=$checkout/dist/cli.js" \
    --env "ISSUE_ORCHESTRATOR_CHECKOUT=$checkout" \
    --env "ISSUE_ORCHESTRATOR_MODE=router" \
    --env "ISSUE_ORCHESTRATOR_INTERVAL_SECONDS=$interval" \
    --env "ISSUE_ORCHESTRATOR_MAX=$max" \
    --env "ISSUE_ORCHESTRATOR_PROJECT=$project" \
    --env "ISSUE_ORCHESTRATOR_PID_FILE=$state_dir/router.pid" \
    --env "ISSUE_ORCHESTRATOR_LOCK_FILE=$state_dir/router.lock" \
    --env "ISSUE_ORCHESTRATOR_LEGACY_HOME=$legacy_home" \
    --env "ISSUE_ORCHESTRATOR_LEGACY_CONFIG=$legacy_config" \
    --env "ISSUE_ORCHESTRATOR_STATE_DECISION=$state_decision" \
    --env "GH_CONFIG_DIR=$gh_config_dir" \
    --env "OPENCODE_CONFIG=$opencode_config" \
    --env "OPENCODE_DATA_DIR=$opencode_data_dir" \
    --env "XDG_CONFIG_HOME=${gh_config_dir%/*}" \
    --env "XDG_DATA_HOME=${opencode_data_dir%/*}" \
    "$container" "$@"
}
