# Deployment assets

These files are optional operator aids. Nothing here runs during `pnpm test`
except read-only validation.

There are two deployment shapes:

1. **Separate worker container** — build the repository image and run the
   router in its own hardened container. Use this when the host does not
   already provide the agent toolchain.
2. **Existing `code-dev` container (`docker exec`)** — supervise the router
   inside an already-running development container that has Node, pnpm, `gh`,
   OpenCode and the project checkouts. Use this on the remote development host
   where `code-dev` already provides the execution boundary and its `gh` /
   OpenCode volumes.

Do not run both shapes against the same state directory. They would compete for
the same SQLite queue.

## Separate worker container

- `systemd/issue-orchestrator-docker.service` — host-level systemd unit for a
  remote Docker host. It runs `docker compose up -d` after boot and
  `docker compose down` on stop. The container's `restart: unless-stopped`
  policy handles crashes and Docker daemon restarts.
- `systemd/docker.env.example` — non-secret deployment paths for that unit.
  Copy it to `/etc/issue-orchestrator/docker.env` and keep it root-owned with
  mode 0600. Credentials stay in the read-only provider mounts.

See [`../docs/service.md`](../docs/service.md#docker-separate-worker-container)
for the full deployment, verification, update, and recovery procedure.

The image must be built once on the host before the unit starts, or refreshed
with `systemctl reload issue-orchestrator-docker.service`:

```sh
cd /opt/issue-orchestrator
docker compose --env-file /etc/issue-orchestrator/docker.env build
docker compose --env-file /etc/issue-orchestrator/docker.env up -d
```

## Existing `code-dev` container (`docker exec`)

- `code-dev/lib.sh` — shared host-side defaults; installed root-owned.
- `code-dev/preflight.sh` — waits for the existing container and runs the
  in-container read-only validation as the unprivileged container user.
- `code-dev/run.sh` — `docker exec` wrapper used by systemd.
- `code-dev/stop.sh` — host wrapper for the in-container stop script.
- `code-dev/stop-container.sh` — verifies PID/start-time/session identity,
  signals the router's own process group, removes the PID file only after a
  clean stop, and fails closed without SIGKILL on timeout.
- `code-dev/check.sh` — in-container state, migration, credential and tool
  validation.
- `code-dev/validate-config.mjs` — config semantics, workspace free space and
  provider-auth entitlement validation.
- `code-dev/container-entrypoint.sh` — in-container flock/PID/start-time/setsid
  wrapper around `docker/worker.sh`.
- `code-dev/init-state.sh` — idempotent creation of the durable state
  directory and non-destructive copy of the existing config.
- `systemd/issue-orchestrator-code-dev.service` — host systemd unit.
- `systemd/code-dev.env.example` — non-secret container paths for the unit.

The unit never starts, stops, restarts, recreates, or reconfigures `code-dev`.
At boot it waits for Docker's own `restart: unless-stopped` policy to bring the
container up and fails closed if that does not happen. Preflight rejects a
compiled CLI older than `src/`, `package.json`, or `tsconfig.json`; build the
checkout with `pnpm build` before enabling or restarting the unit.

The stop wrapper terminates the router session/process group but does **not**
claim to cover detached agent supervisors. The CLI owns its agent process
groups and recovery; on timeout the stop script fails closed rather than
SIGKILLing a group that may leave a detached agent session half-dead.

The durable state directory must be on a path the container already mounts from
the host. Adding a new mount would require recreating `code-dev`, so the
recommended state path is a private subdirectory of the existing persistent
OpenCode state volume:

```text
container: /home/dev/.local/state/opencode/issue-orchestrator
host:      /var/lib/docker/volumes/dev-vm_opencode-state/_data/issue-orchestrator
```

The host path is confirmed with `docker inspect code-dev`; do not hardcode it
elsewhere. The existing `/home/dev/.config/gh`,
`/home/dev/.local/share/opencode` and `/home/dev/.local/state/opencode`
volumes remain in use; no new volume or container restart is required. On the
current host the `/projects` bind mount is only about 1.2 GiB free, so it is not
the default state location.

Preflight requires the enabled project to have a GitHub account and a
non-empty `trusted_authors` allowlist, a private provider-auth export at the
OpenCode data path, an explicit migration decision when legacy SQLite state
exists, an up-to-date compiled CLI, and at least 1 GiB free in the workspace
filesystem. See
[`../docs/service.md`](../docs/service.md#existing-code-dev-container-docker-exec)
for installation, state migration, verification, update, and rollback steps.

Do not add credentials to compose, units, scripts, or environment files. Do not
mount the Docker socket unless a configured DoD gate explicitly requires it.
