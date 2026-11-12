#!/bin/sh
# Read-only deployment preflight executed inside the existing code-dev
# container as the unprivileged container user.
#
# It validates the durable state/config, the existing gh and OpenCode volumes,
# the CLI/worker files, and the required executables. It creates nothing,
# prints no file contents and contacts no provider or model API.
set -u
umask 077

fail() {
  echo "issue-orchestrator-code-dev-check: $*" >&2
  exit 78
}

note() {
  echo "issue-orchestrator-code-dev-check: $*"
}

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
checkout=${ISSUE_ORCHESTRATOR_CHECKOUT:-$(CDPATH= cd "$script_dir/../.." && pwd)}
home=${ISSUE_ORCHESTRATOR_HOME:-}
workspace=${ISSUE_ORCHESTRATOR_REPO:-}
config=${ISSUE_ORCHESTRATOR_CONFIG:-}
mode=${ISSUE_ORCHESTRATOR_MODE:-router}
home_dir=${HOME:-/home/dev}

if [ -z "$config" ]; then
  config=$home/config.jsonc
fi

[ "$mode" = router ] || fail 'only ISSUE_ORCHESTRATOR_MODE=router is supported by the code-dev supervisor'
[ "$(id -u)" -ne 0 ] || fail 'run the router as the non-root container user (for example dev), not root'
[ -n "$home" ] || fail 'ISSUE_ORCHESTRATOR_HOME is not set'
[ -n "$workspace" ] || fail 'ISSUE_ORCHESTRATOR_REPO is not set'
[ -n "$config" ] || fail 'ISSUE_ORCHESTRATOR_CONFIG is not set'

case "$home" in /*) ;; *) fail 'ISSUE_ORCHESTRATOR_HOME must be an absolute container path' ;; esac
case "$workspace" in /*) ;; *) fail 'ISSUE_ORCHESTRATOR_REPO must be an absolute container path' ;; esac
case "$config" in /*) ;; *) fail 'ISSUE_ORCHESTRATOR_CONFIG must be an absolute container path' ;; esac
case "$checkout" in /*) ;; *) fail 'ISSUE_ORCHESTRATOR_CHECKOUT must be an absolute container path' ;; esac

if stat -c %u / >/dev/null 2>&1; then
  stat_uid() { stat -c %u "$1"; }
  stat_mode() { stat -c %a "$1"; }
else
  stat_uid() { stat -f %u "$1"; }
  stat_mode() { stat -f %Lp "$1"; }
fi
uid=$(id -u)

require_private_file() {
  label=$1
  file=$2
  [ -f "$file" ] && [ ! -L "$file" ] || fail "$label must be a regular non-symlink file: $file"
  [ -r "$file" ] || fail "$label is not readable: $file"
  [ "$(stat_uid "$file")" = "$uid" ] || fail "$label must be owned by the router UID ($uid): $file"
  found=$(stat_mode "$file")
  case "$found" in
    400|600|0400|0600) ;;
    *) fail "$label must be mode 0600 or 0400 (found $found): $file" ;;
  esac
}

require_private_dir() {
  label=$1
  directory=$2
  expected_mode=$3
  [ -d "$directory" ] && [ ! -L "$directory" ] || fail "$label must be a real non-symlink directory: $directory"
  [ -r "$directory" ] && [ -x "$directory" ] || fail "$label is not readable and searchable: $directory"
  [ "$(stat_uid "$directory")" = "$uid" ] || fail "$label must be owned by the router UID ($uid): $directory"
  found=$(stat_mode "$directory")
  case "$expected_mode" in
    700)
      case "$found" in
        700|0700) ;;
        *) fail "$label must be mode 0700 (found $found): $directory" ;;
      esac
      ;;
    private)
      case "$found" in
        700|750|755|500|550|555|0700|0750|0755|0500|0550|0555) ;;
        *) fail "$label must not be group/other writable (found $found): $directory" ;;
      esac
      ;;
  esac
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required executable $1 is not on PATH"
}

# The durable runtime home stores SQLite, worktrees, ticket state and private
# agent sessions. It must exist already; preflight never creates deployment
# state implicitly.
require_private_dir 'durable state directory (ISSUE_ORCHESTRATOR_HOME)' "$home" 700
[ -w "$home" ] || fail "durable state directory is not writable: $home"
state_fs=$(stat -f -c %T "$home" 2>/dev/null || true)
case "$state_fs" in
  overlay|overlayfs)
    fail 'durable state directory is on the container layer (overlayfs); use an existing persistent volume'
    ;;
  '')
    note 'warning: cannot determine the filesystem type of the state directory'
    ;;
esac

case "$config" in
  "$home"/*) ;;
  *) note 'warning: config is outside ISSUE_ORCHESTRATOR_HOME; verify that its mount is durable' ;;
esac
require_private_file 'Issue Orchestrator config' "$config"

# A durable database is the explicit migration decision. If old state exists
# and the durable database does not, starting would silently create an empty
# queue. Require either a migration or an explicit fresh-start decision in the
# root-owned environment file.
legacy_home=${ISSUE_ORCHESTRATOR_LEGACY_HOME:-$home_dir/.config/issue-orchestrator}
legacy_db=$legacy_home/orchestrator.sqlite3
durable_db=$home/orchestrator.sqlite3
state_decision=${ISSUE_ORCHESTRATOR_STATE_DECISION:-}
case "$state_decision" in
  ''|migrated|fresh) ;;
  *) fail 'ISSUE_ORCHESTRATOR_STATE_DECISION must be "migrated" or "fresh" when set' ;;
esac
if [ -e "$legacy_db" ] || [ -L "$legacy_db" ]; then
  if [ ! -e "$durable_db" ]; then
    case "$state_decision" in
      fresh)
        note 'warning: starting with empty durable state by explicit ISSUE_ORCHESTRATOR_STATE_DECISION=fresh'
        ;;
      *)
        fail "legacy SQLite state exists at $legacy_db but durable state at $durable_db is missing; copy it while the old router is stopped, or set ISSUE_ORCHESTRATOR_STATE_DECISION=fresh explicitly"
        ;;
    esac
  fi
fi
if [ "$state_decision" = migrated ] && [ ! -e "$durable_db" ]; then
  fail "ISSUE_ORCHESTRATOR_STATE_DECISION=migrated requires a durable SQLite database at $durable_db"
fi

for state_file in "$home/orchestrator.sqlite3" "$home/orchestrator.sqlite3-wal" "$home/orchestrator.sqlite3-shm"; do
  if [ -e "$state_file" ] || [ -L "$state_file" ]; then
    require_private_file 'SQLite runtime file' "$state_file"
  fi
done
for state_directory in "$home/agent-sessions" "$home/tickets" "$home/dod-reports"; do
  if [ -e "$state_directory" ] || [ -L "$state_directory" ]; then
    require_private_dir 'private runtime directory' "$state_directory" private
  fi
done

free_kb=$(df -Pk "$home" 2>/dev/null | awk 'NR == 2 {print $4}')
case "$free_kb" in
  ''|*[!0-9]*) fail 'cannot determine free space for ISSUE_ORCHESTRATOR_HOME' ;;
esac
[ "$free_kb" -ge 1048576 ] || fail "less than 1 GiB is free in ISSUE_ORCHESTRATOR_HOME (${free_kb} KiB available)"

[ -f "$checkout/dist/cli.js" ] && [ -r "$checkout/dist/cli.js" ] && [ ! -L "$checkout/dist/cli.js" ] \
  || fail "compiled CLI is missing or unreadable: $checkout/dist/cli.js (run pnpm build)"
[ -f "$checkout/docker/worker.sh" ] && [ -r "$checkout/docker/worker.sh" ] && [ ! -L "$checkout/docker/worker.sh" ] \
  || fail "worker entrypoint is missing or unreadable: $checkout/docker/worker.sh"

# A compiled CLI older than its sources is not a committed deployment build.
stale_source=$(find "$checkout/src" "$checkout/package.json" "$checkout/tsconfig.json" \
  -type f -newer "$checkout/dist/cli.js" -print -quit 2>/dev/null || true)
[ -z "$stale_source" ] || fail "compiled CLI is older than deployment inputs (run pnpm build): $stale_source"

[ -d "$workspace/.git" ] || [ -f "$workspace/.git" ] || fail "workspace is not a Git checkout: $workspace"
git -C "$workspace" rev-parse --git-dir >/dev/null 2>&1 || fail "git cannot read the workspace: $workspace"
[ -w "$workspace" ] || fail "workspace is not writable by the router user: $workspace"
workspace_free_kb=$(df -Pk "$workspace" 2>/dev/null | awk 'NR == 2 {print $4}')
case "$workspace_free_kb" in
  ''|*[!0-9]*) fail 'cannot determine free space for the workspace' ;;
esac
[ "$workspace_free_kb" -ge 1048576 ] || fail "less than 1 GiB is free in the workspace filesystem (${workspace_free_kb} KiB available)"

gh_dir=${GH_CONFIG_DIR:-${XDG_CONFIG_HOME:-$home_dir/.config}/gh}
opencode_config=${OPENCODE_CONFIG:-}
if [ -z "$opencode_config" ]; then
  for candidate in "${XDG_CONFIG_HOME:-$home_dir/.config}/opencode/opencode.jsonc" \
    "${XDG_CONFIG_HOME:-$home_dir/.config}/opencode/opencode.json"; do
    if [ -f "$candidate" ] && [ -r "$candidate" ]; then
      opencode_config=$candidate
      break
    fi
  done
fi
opencode_data=${OPENCODE_DATA_DIR:-${XDG_DATA_HOME:-$home_dir/.local/share}/opencode}

require_private_dir 'GitHub CLI credential directory' "$gh_dir" private
require_private_file 'GitHub CLI hosts.yml' "$gh_dir/hosts.yml"
require_private_dir 'OpenCode data directory' "$opencode_data" private
# New ticket-agent sessions start with private XDG data and need a source
# provider-auth export. The runner reads $XDG_DATA_HOME/opencode/auth.json.
require_private_file 'OpenCode provider auth export' "$opencode_data/auth.json"
[ -n "$opencode_config" ] || fail 'OpenCode config is missing; set OPENCODE_CONFIG or mount opencode.jsonc'
[ -f "$opencode_config" ] && [ -r "$opencode_config" ] && [ ! -L "$opencode_config" ] \
  || fail "OpenCode config must be a readable regular file: $opencode_config"

for executable in node git gh opencode flock setsid awk sed tr df find; do
  require_command "$executable"
done
node_major=$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || true)
case "$node_major" in
  ''|*[!0-9]*) fail 'cannot determine the Node.js version' ;;
esac
[ "$node_major" -ge 24 ] || fail "Node.js 24 or newer is required (found $node_major)"

node "$checkout/dist/cli.js" --version >/dev/null 2>&1 || fail 'compiled CLI does not start'

# Validate the JSONC schema, ticket-routing semantics and provider auth without
# opening SQLite or contacting a provider. Errors name fields, never values.
[ -f "$checkout/deploy/code-dev/validate-config.mjs" ] && [ -r "$checkout/deploy/code-dev/validate-config.mjs" ] \
  || fail "config validator is missing: $checkout/deploy/code-dev/validate-config.mjs"
if ! ISSUE_ORCHESTRATOR_CHECKOUT="$checkout" \
  ISSUE_ORCHESTRATOR_CONFIG="$config" \
  ISSUE_ORCHESTRATOR_REPO="$workspace" \
  ISSUE_ORCHESTRATOR_OPENCODE_AUTH="$opencode_data/auth.json" \
  node "$checkout/deploy/code-dev/validate-config.mjs"; then
  exit 2
fi

note 'preflight passed: durable state, config, credentials and tooling are ready'
