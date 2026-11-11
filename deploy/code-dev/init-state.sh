#!/bin/sh
# Idempotent, non-destructive state bootstrap for the existing code-dev
# deployment.
#
# It creates the durable state directory (mode 0700) and copies the existing
# private config only when the durable config is absent. It never copies or
# deletes the SQLite database, agent sessions, or worktrees: migrate those
# manually after the old router has stopped (see docs/service.md).
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
. "$script_dir/lib.sh"

command -v "$docker_bin" >/dev/null 2>&1 || die 69 "docker executable is not on PATH: $docker_bin"

if ! running=$("$docker_bin" inspect --format '{{.State.Running}}' "$container" 2>/dev/null) \
  || [ "$running" != true ]; then
  die 69 "container $container is not running; start it explicitly. This helper never starts or restarts it."
fi

container_exec /bin/sh -c '
  set -eu
  umask 077
  state=$1
  config=$2
  legacy=$3

  if [ -e "$state" ]; then
    [ -d "$state" ] && [ ! -L "$state" ] || {
      echo "issue-orchestrator-code-dev: state path is not a real directory: $state" >&2
      exit 78
    }
    [ "$(stat -c %u "$state")" = "$(id -u)" ] || {
      echo "issue-orchestrator-code-dev: state directory is not owned by the router user: $state" >&2
      exit 78
    }
    found=$(stat -c %a "$state")
    case "$found" in
      700|0700) ;;
      *)
        echo "issue-orchestrator-code-dev: state directory must be mode 0700 (found $found); run chmod 700 $state" >&2
        exit 78
        ;;
    esac
  else
    mkdir -m 700 "$state"
    echo "issue-orchestrator-code-dev: created durable state directory $state"
  fi

  legacy_db=$(dirname "$legacy")/orchestrator.sqlite3
  if [ -e "$legacy_db" ] && [ ! -e "$state/orchestrator.sqlite3" ]; then
    echo "issue-orchestrator-code-dev: warning: legacy SQLite state exists at $legacy_db" >&2
    echo "issue-orchestrator-code-dev: copy it while the old router is stopped and set ISSUE_ORCHESTRATOR_STATE_DECISION=migrated, or explicitly set fresh" >&2
  fi

  case "$config" in
    "$state"/*) ;;
    *)
      echo "issue-orchestrator-code-dev: this helper expects config inside the durable state directory" >&2
      exit 64
      ;;
  esac

  if [ -e "$config" ] || [ -L "$config" ]; then
    [ -f "$config" ] && [ ! -L "$config" ] || {
      echo "issue-orchestrator-code-dev: durable config is not a regular file: $config" >&2
      exit 78
    }
    echo "issue-orchestrator-code-dev: durable config already exists; left unchanged"
  elif [ -f "$legacy" ] && [ ! -L "$legacy" ]; then
    cp -p "$legacy" "$config"
    chmod 600 "$config"
    echo "issue-orchestrator-code-dev: copied existing config into durable state"
  else
    echo "issue-orchestrator-code-dev: no durable or legacy config found; create $config with mode 0600" >&2
    exit 78
  fi
' sh "$state_dir" "$config" "$legacy_config"

echo 'issue-orchestrator-code-dev: state bootstrap complete; SQLite/session migration remains manual'
