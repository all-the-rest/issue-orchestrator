# Background worker operations

`issue-orchestrator run --once` is the legacy worker interface; `tickets poll`
is the V1 ticket-router interface. Both remain usable directly, without a
service installation. Each `tickets poll` invocation discovers trusted events
and dispatches at most `--max` tickets per configured project. Distinct ticket
issues run in parallel up to `tickets.max_concurrency`; the legacy builder
limits remain separate. SQLite atomically admits sessions, claims and resources
across overlapping pollers and recoverable restarts. Events for one issue are
coalesced for `tickets.quiet_period_ms` (default 60 seconds), and a burst is
committed with its cursor and deadline before any agent dispatch. While a long
turn runs, an intake ticker (`tickets.intake_poll_ms`, default 30 seconds)
continues recording other issues' events and discovering new trusted issues;
those are dispatched on a later poll. The running issue's exclusive session
lease (and an undelivered pending turn) defers its own intake until that work
finishes, then collection resumes from the same durable cursor without loss.
Intake errors appear in the poll result
and use exponential backoff capped at the smaller of five minutes and eight base
intervals. Polling still paces
delivery: the worker interval adds to the coalescing latency, so
keep it at or below the quiet period. The persisted global cap and a durable
lease/heartbeat with owner-CAS writes prevent cross-poller and cross-container
double admission. SIGTERM/SIGINT aborts every active OpenCode process group,
leaves interrupted turns resumable without publishing FAILED, waits for
cleanup, and exits 143/130. Because a crash after dispatch can replay the same
turn, delivery is at-least-once; agent side effects must be idempotent. The
durable issue claim,
worktree, workflow checkpoint and session remain for the next invocation; an
interrupted session is not a failed or terminal workflow. A queue claim
intentionally remains held for exact resumption; the agent execution and
process mutation leases are released on normal signal cleanup. SIGKILL cannot
run cleanup; stale process leases are reclaimed and recovery checks durable
branch/PR/evidence state before continuing.

Legacy claims without a verifiable process ID are not automatically reaped or
resumed. After independently verifying that the old worker has stopped, use
`resume-lock <project> <issue> --confirm-stale` for explicit recovery. Do not
confirm a claim while its previous worker might still be running.

## launchd / systemd

From the checked-out repository, run `node dist/cli.js service install --print`.
This prints templates only: it does not read config, write files, call
launchctl/systemctl, use sudo, or elevate. The template uses the current
absolute Node and CLI paths and current repository as working directory. Save
the printed plist under `~/Library/LaunchAgents` on macOS or both units under
`~/.config/systemd/user` on Linux, then follow the exact commands printed.
These are user-level services; do not install them as root. The Linux timer
runs after boot and every five minutes; launchd runs at load and every five
minutes. Ensure the user's login environment exposes the required provider
CLIs/configuration.

## Docker (separate worker container)

`docker compose up -d --build` builds the CLI from source (no host `pnpm build`
needed) and starts the persistent ticket router. The worker runs
`node dist/cli.js tickets poll` once, sleeps, and repeats; `tickets poll` reuses
the durable SQLite queue and ticket sessions, so a container restart does not
start a second workflow. Recovery remains fail-closed: the CLI inspects stored
branch, pull-request, and evidence identity before continuing.
`restart: unless-stopped` restarts the container after a crash or Docker daemon
restart, and `stop_grace_period: 5m` gives the active agent time to finish its
safe step and clean up its OpenCode process group. `docker compose stop` and
`docker compose down` do not delete the named `orchestrator-home` volume.

The container runs as UID 1000, the non-root `node` user, with
`no-new-privileges`. Keep the named `orchestrator-home` volume: it stores the
SQLite queue, ticket worktrees, agent sessions, and durable recovery artifacts.

### Modes

- `ISSUE_ORCHESTRATOR_MODE=router` (default) runs `tickets poll` in a paced
  loop. Configure `agent_runner: "opencode"`, a non-empty `trusted_authors`
  allowlist, and the target workspace. Set `tickets.max_concurrency` (for
  example `2`) and `tickets.quiet_period_ms` (for example `60000`) in the same
  config. A repository may also set `tickets.activation_mention` to require an
  exact mention by a trusted author before its first ticket-agent bootstrap;
  the intake ticker rechecks issues while they remain in the bounded listing
  window, and admitted sessions need no repeat mention. When the bounded
  listing is saturated, a capped mention search also finds late activations
  outside that window; search indexing lag and matches beyond the cap remain
  limitations. Activation reads are
  hard-bounded per poll (at most 20 issues, each with at most 4 comment pages).
  Durable content-free cursors survive a restart: an ordinary comment re-reads
  the newest page and continues history, a new page restarts the bounded range,
  and an incomplete scan is reported as deferred rather than as a negative. One
  durable time-based API budget (45 requests per minute) is shared by every
  worker and project for activation reads; a separate durable rolling-window
  search budget admits at most 30 mention-search requests in any minute across
  workers and projects. An exhausted budget defers without any provider request.
  Granted reservations rotate across projects in durable least-recently-served
  order, so a saturated project cannot starve later ones across polls, intake
  ticks or restarts. A per-issue activation failure is a local diagnostic; other
  intake failures (listing, provider/search, association or task) back the
  shared cadence off, never below the configured base interval. An explicit
  operator `goal` bypasses the poller gate. The
  global session cap is shared by every worker
  using the runtime home; a full cap defers work without dropping queued
  events.
- `ISSUE_ORCHESTRATOR_MODE=builder` retains the legacy `run --once` builder
  loop. It requires the preloaded builder image for its OCI sandbox.

Set `ISSUE_ORCHESTRATOR_INTERVAL_SECONDS` to an integer from 60 through 999999;
invalid or shorter intervals make the worker exit instead of hot-looping. A
failed poll is paced by the same interval. Optionally set
`ISSUE_ORCHESTRATOR_PROJECT` to one `owner/repository` and
`ISSUE_ORCHESTRATOR_MAX` to limit tickets per poll. The worker starts with
`--once` for a single cycle, which is useful for a deployment smoke test.

### Required deployment inputs

The worker validates these inputs before starting and exits non-zero rather
than running with a partial deployment. It never prints file contents or
environment values.

| Variable | Purpose |
| --- | --- |
| `ISSUE_ORCHESTRATOR_WORKSPACE` | Host path of the target Git checkout, mounted read/write at `/workspace`. It must be writable by UID 1000 because the agent creates worktrees, commits, and pushes. Defaults to the compose directory. |
| `ISSUE_ORCHESTRATOR_CONFIG_FILE` | Host path of the private `config.jsonc`, mounted read-only at `/home/node/.config/issue-orchestrator/config.jsonc`. Defaults to `./config.jsonc`. |
| `OPENCODE_CONFIG` | Host path of the OpenCode config, mounted read-only at `/home/node/.config/opencode/opencode.jsonc`. Required. |
| `OPENCODE_DATA_DIR` | Host path of the OpenCode data/auth directory, mounted read-only at `/home/node/.local/share/opencode`. Required. If `auth.json` is present it must be mode 0600 and owned by UID 1000. |
| `GH_CONFIG_DIR` | Host path of the GitHub CLI credential directory, mounted read-only at `/home/node/.config/gh`. Required. The directory must not be group/other writable and `hosts.yml` must be mode 0600 and owned by UID 1000, matching the ticket runner's checks. |
| `ISSUE_ORCHESTRATOR_RUNTIME_BIN` | Host directory of vetted `gh` and `opencode` executables, mounted read-only and prepended to `PATH`. Defaults to `./runtime-bin`. |

The image bundles `git` but not `gh`, `opencode`, or Docker CLI. Put vetted,
compatible executables in `runtime-bin/` or build a locally controlled
derivative. The worker requires `git`, `gh`, and `opencode` on `PATH` in router
mode. Provider credentials in mounted files are available to the worker and
agent; scope them narrowly. Never put credentials in the image, compose file,
unit file, or an environment file.

Prepare private credentials on the deployment host, for example:

```sh
install -d -m 700 /srv/issue-orchestrator/gh
install -m 600 "$HOME/.config/gh/hosts.yml" /srv/issue-orchestrator/gh/hosts.yml
install -d -m 700 /srv/issue-orchestrator/opencode-data
chmod 600 /srv/issue-orchestrator/config.jsonc
chmod 600 /srv/issue-orchestrator/opencode.jsonc
```

The container always runs as UID/GID 1000. Bind mounts preserve host
ownership, so when the host operator is not UID 1000, give the mounted
workspace and credential paths to the container UID:

```sh
sudo chown -R 1000:1000 /srv/issue-orchestrator/workspace \
  /srv/issue-orchestrator/gh /srv/issue-orchestrator/opencode-data
sudo chown 1000:1000 /srv/issue-orchestrator/config.jsonc \
  /srv/issue-orchestrator/opencode.jsonc
```

Do not run the container as root to avoid this step.

The image does not mount a Docker socket. If configured Docker-backed DoD
gates need one, explicitly add a socket bind mount and a vetted Docker CLI in
`runtime-bin/`. This grants powerful host control; without it, those gates fail
closed. Do not mount the host Docker socket by default.

### Remote host autostart

On a remote Docker host, autostart has two layers:

1. Docker itself must start at boot (`systemctl enable --now docker`).
2. The compose project must start after boot. `restart: unless-stopped`
   restarts a running container, but it does not recreate a removed container
   or start a project that was never brought up. The provided systemd unit
   ensures `docker compose up -d` runs on every boot and stops the project on
   `systemctl stop`.

Install the deployment checkout and unit on the remote host:

```sh
sudo install -d -m 755 /opt/issue-orchestrator
sudo git -C /opt/issue-orchestrator clone https://github.com/all-the-rest/issue-orchestrator.git .
sudo git -C /opt/issue-orchestrator fetch origin main
sudo git -C /opt/issue-orchestrator switch --detach origin/main
cd /opt/issue-orchestrator

# Non-secret deployment paths. Keep this file root-owned and mode 0600.
sudo install -d -m 700 /etc/issue-orchestrator
sudo install -m 600 deploy/systemd/docker.env.example /etc/issue-orchestrator/docker.env
sudo editor /etc/issue-orchestrator/docker.env

# Build before the unit starts, or let ExecReload do it after an update.
sudo docker compose --env-file /etc/issue-orchestrator/docker.env build
sudo docker compose --env-file /etc/issue-orchestrator/docker.env up -d

sudo install -m 644 deploy/systemd/issue-orchestrator-docker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable issue-orchestrator-docker.service
sudo systemctl start issue-orchestrator-docker.service
```

The example environment file contains only host paths:

```sh
ISSUE_ORCHESTRATOR_WORKSPACE=/srv/issue-orchestrator/workspace
ISSUE_ORCHESTRATOR_CONFIG_FILE=/srv/issue-orchestrator/config.jsonc
OPENCODE_CONFIG=/srv/issue-orchestrator/opencode.jsonc
OPENCODE_DATA_DIR=/srv/issue-orchestrator/opencode-data
GH_CONFIG_DIR=/srv/issue-orchestrator/gh
ISSUE_ORCHESTRATOR_RUNTIME_BIN=/srv/issue-orchestrator/runtime-bin
```

`systemctl reload issue-orchestrator-docker.service` later builds and restarts
the project with the unit's environment. If you run compose manually, pass the
same `--env-file`; otherwise the required `OPENCODE_*` and `GH_CONFIG_DIR`
interpolations are missing.

If you use a remote Docker context such as `DOCKER_HOST=ssh://host` from a
workstation, every compose bind-mount source is resolved on the remote daemon,
not on your workstation. The deployment checkout, config, workspace, and
credential directories must exist on that host; do not assume local paths are
mounted.

### Deploying an update and verifying recovery

Deploy only a committed revision from `origin/main`:

```sh
cd /opt/issue-orchestrator
sudo git fetch origin main
sudo git switch --detach origin/main
sudo docker compose --env-file /etc/issue-orchestrator/docker.env up -d --build --remove-orphans
sudo docker compose --env-file /etc/issue-orchestrator/docker.env logs --tail=100 worker
```

Verification checks:

```sh
systemctl is-enabled issue-orchestrator-docker.service
systemctl is-active issue-orchestrator-docker.service
docker compose --env-file /etc/issue-orchestrator/docker.env ps worker
docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' \
  "$(docker compose --env-file /etc/issue-orchestrator/docker.env ps -q worker)"
docker compose --env-file /etc/issue-orchestrator/docker.env logs --tail=100 worker
```

The worker's first line reports the selected mode and interval, not
credentials. A successful startup shows `mode=router`. A preflight refusal
uses exit 64 (invalid usage), 69 (missing executable), or 78 (missing or
unsafe file/directory); fix the mount and restart, do not bypass the check.
Docker restarts a preflight failure with its normal exponential backoff, so
inspect `docker compose logs` rather than treating the restart count as
progress. After a successful restart, the CLI reuses durable state and resumes
the queue. Do not run `docker compose down -v`: it deletes the named volume and
with it the ticket queue and recovery artifacts.

On shutdown, allow the worker to finish its current safe step and clean up the
OpenCode process group, then restart normally. SIGKILL recovery is fail-closed
if stored branch, pull request, or evidence identity cannot be verified. The
optional standalone daemon is deferred.

Platform gates: launchd templates are validated by macOS CI; Linux units are
checked in Linux CI/container. This package does not install service files
automatically.

## Existing `code-dev` container (`docker exec`)

Use this deployment shape when the remote host already runs a long-lived
development container with the complete toolchain (`node`, `pnpm`, `gh`,
`opencode`, `git`, Docker CLI) and the existing `gh` / OpenCode volumes. The
separate compose worker above bundles only `git`; it needs a runtime-bin or a
derivative image. Running inside `code-dev` reuses the container that already
is the ticket-agent execution boundary, so no new container, image build,
socket mount, or container recreation is required.

The supervisor is a host systemd unit around `docker exec`. It runs the
in-container scripts as the unprivileged container user (default `dev`), not as
root. The unit never starts, stops, restarts, recreates, or reconfigures
`code-dev`; it only waits for Docker's own `restart: unless-stopped` policy at
boot.

A detached `docker exec` was rejected: it has no supervisor, no restart
contract, and no reliable stop path. A new sidecar would duplicate the missing
toolchain, while adding a volume or changing the entrypoint would require
recreating `code-dev`. The host unit plus explicit process-group signaling
keeps the existing container and its volumes exactly as they are.

### How it works

1. `systemd` starts `issue-orchestrator-code-dev.service` after
   `docker.service`.
2. `preflight.sh` waits for the existing container to be running and then
   executes `check.sh` inside it as the container user.
3. `check.sh` validates the durable state directory, private config, SQLite
   files, migration decision, `gh`/OpenCode credential paths, provider-auth
   export, workspace free space, compiled-CLI freshness, required executables,
   and the config semantics: every enabled project needs a GitHub account, a
   non-empty `trusted_authors` allowlist, and the `opencode` runner. It performs
   no network requests and prints no file contents.
4. `container-entrypoint.sh` takes an exclusive `flock`, writes the session
   leader PID **and kernel start time** to the durable state directory, and
   `exec`s `docker/worker.sh` in a fresh `setsid` process group.
5. `stop.sh` delegates to `stop-container.sh`, which verifies the recorded PID,
   start time, session-leader identity, process group and cmdline before it
   sends `SIGTERM`. It waits up to `ISSUE_ORCHESTRATOR_STOP_TIMEOUT_SECONDS`
   (default 300) and then **fails closed without SIGKILL**. Killing the
   host-side `docker exec` client does **not** signal the process inside the
   container.

The flock prevents a second router after a supervisor restart or an
in-container crash. A stale PID is never signalled: a reused PID is detected
by the start-time mismatch, and an identity mismatch is refused. The PID file
is removed only after a verified clean stop.

The process group contains the worker and the processes it keeps in that same
session. It does **not** guarantee coverage of agent/OpenCode supervisors that
the CLI detached into other process groups. The CLI owns their shutdown and
durable recovery; the stop wrapper does not SIGKILL after timeout because that
could leave a detached agent session half-dead.

### Durable state and config

Container-layer paths such as `/home/dev/.config/issue-orchestrator` are lost
when `code-dev` is recreated. Adding a dedicated volume would require
recreating the container, so state lives in a private subdirectory of an
existing persistent volume:

```text
container: /home/dev/.local/state/opencode/issue-orchestrator
host:      /var/lib/docker/volumes/dev-vm_opencode-state/_data/issue-orchestrator
```

The host path is the current `dev-vm_opencode-state` volume; confirm it with
`docker inspect code-dev` rather than assuming the volume name. The
`/projects` bind mount is not the default because it has only about 1.2 GiB
free on the current host. A dedicated volume on a future container recreation
is preferable; the state directory can then be copied across.

`ISSUE_ORCHESTRATOR_HOME` and `ISSUE_ORCHESTRATOR_CONFIG` must both point into
that directory. It stores the SQLite queue, worktrees, ticket state, DoD
reports, and private agent sessions. The directory must be mode `0700` and
owned by the container user (UID 1000 on the current host). The config must be
a regular non-symlink file, mode `0600` or `0400`. Preflight rejects a state
directory on `overlayfs`, so a path under `/home/dev/.config` fails even if it
exists; that is the warning that the data would die with the container.

The existing `/home/dev/.config/gh`, `/home/dev/.local/share/opencode` and
`/home/dev/.local/state/opencode` volumes are already durable and stay in use.
Do not copy credentials into the state directory or the environment file.

One exception is created by the router itself: at session start the ticket
runner writes a narrowed `gh` credential (only the `github.com` host block, mode
`0600`) and a matching Git credential helper into
`<state>/agent-sessions/<session>/`. That copy stays outside the worktree and is
never written to SQLite or the environment, but it means a backup or copy of the
state directory contains a usable GitHub credential for the configured bot
account. Treat state-directory backups as secret material and keep the directory
mode `0700`.

Preflight requires a private provider-auth export at
`/home/dev/.local/share/opencode/auth.json` (mode `0600`, owned by the router
user) with an active credential for the configured model provider. New ticket
sessions get a private data directory and cannot fall back to the operator's
unexported OpenCode database. If the old state contains
`openai-auth-export.json`, copy it without overwriting an existing file:

```sh
docker exec -u dev code-dev sh -c '
  test -e /home/dev/.local/share/opencode/auth.json ||
    install -m 600 /home/dev/.config/issue-orchestrator/openai-auth-export.json \
      /home/dev/.local/share/opencode/auth.json
'
```

### Security boundary

The supervisor runs as root on the host because it needs the Docker API. The
router and every ticket agent run as the same container UID (`dev`) as an
interactive `code-dev` session. That UID can read the actual `gh` login,
provider auth export, and every project checkout, and can use the container's
`DOCKER_HOST=tcp://dind:2375` endpoint. The `0700` state directory does not
isolate the router from that same UID. Code-dev isolation is a boundary against
the host and other containers, not a boundary between the operator's shell and
the router. Scope the bot account, provider credentials, and dind access
accordingly; revoke them if the container is compromised. The root-owned host
scripts are the privilege boundary for `docker exec`; keep them root-owned.

### Install

Prerequisite: `code-dev` is already running and reachable with `docker exec`.
Do not create a second Compose project or change the `dev-vm` stack.

```sh
# From a checkout of this repository on the host.
sudo install -d -m 0755 /usr/local/lib/issue-orchestrator
sudo install -m 0555 \
  deploy/code-dev/lib.sh \
  deploy/code-dev/preflight.sh \
  deploy/code-dev/run.sh \
  deploy/code-dev/stop.sh \
  deploy/code-dev/init-state.sh \
  /usr/local/lib/issue-orchestrator/
sudo install -d -m 0700 /etc/issue-orchestrator
sudo install -m 0600 deploy/systemd/code-dev.env.example \
  /etc/issue-orchestrator/code-dev.env
sudo editor /etc/issue-orchestrator/code-dev.env
```

Review every path in the environment file. It contains container paths only:
`ISSUE_ORCHESTRATOR_CHECKOUT` is the orchestrator code checkout,
`ISSUE_ORCHESTRATOR_WORKSPACE` is the configured target repository checkout,
and `ISSUE_ORCHESTRATOR_STATE_DIR` is the durable state directory. Keep the
file root-owned and mode `0600`.

Only the host scripts are installed under `/usr/local/lib/issue-orchestrator`.
The container-side `check.sh`, `container-entrypoint.sh` and
`stop-container.sh` run from the `ISSUE_ORCHESTRATOR_CHECKOUT` bind mount, so
that checkout must contain this deployment revision and an up-to-date
`dist/` before the unit starts.

Create the durable state directory and copy the existing config without
overwriting anything:

```sh
sudo env ISSUE_ORCHESTRATOR_ENV_FILE=/etc/issue-orchestrator/code-dev.env \
  /usr/local/lib/issue-orchestrator/init-state.sh
```

The environment file must stay root-owned and mode `0600`; both systemd and
the optional manual-invocation helper refuse to consume a user-writable file as
root.

If the helper reports that no config exists, create
`/home/dev/.local/state/opencode/issue-orchestrator/config.jsonc` in the
container with mode `0600` before continuing. Use the existing private config
as the starting point, for example:

```sh
docker exec -u dev code-dev sh -c '
  install -d -m 700 /home/dev/.local/state/opencode/issue-orchestrator
  test -e /home/dev/.local/state/opencode/issue-orchestrator/config.jsonc ||
    cp -p /home/dev/.config/issue-orchestrator/config.jsonc \
          /home/dev/.local/state/opencode/issue-orchestrator/config.jsonc
'
```

Run the same preflight that systemd will run:

```sh
sudo env ISSUE_ORCHESTRATOR_ENV_FILE=/etc/issue-orchestrator/code-dev.env \
  /usr/local/lib/issue-orchestrator/preflight.sh
```

The preflight exits `2` for invalid config or missing provider-auth
entitlement, `64` for invalid deployment values, `69` for a missing
container/executable, and `78` for unsafe or missing files. It never starts the
container; start `code-dev` explicitly and retry.

If the enabled project has no `trusted_authors`, or the provider auth is still
only an unexported file, preflight reports that before any router starts. Fix
the config and install the private `auth.json` at the path above.

A compiled `dist/cli.js` older than `src/`, `package.json`, or `tsconfig.json`
is rejected. Build from the committed revision first:

```sh
docker exec -u dev -w /projects/issue-orchestrator code-dev   sh -lc 'pnpm install --frozen-lockfile && pnpm build'
```

### Migrate old ephemeral state

Stop any manually started router first. This state copy is a one-way snapshot,
not a general resumable migration: a copied database is not proof that in-flight
sessions or queue records can resume. Use SQLite's online `.backup` into a
destination that does not exist yet, with every old writer stopped, then keep the
originals as a rollback copy:

```sh
# Verify no old router is active before copying.
docker exec -u dev code-dev sh -lc '
  ps -eo pid,pgid,args | grep "dist/cli.js tickets poll" | grep -v grep || true
'

docker exec -u dev code-dev sh -c '
  src=/home/dev/.config/issue-orchestrator
  dst=/home/dev/.local/state/opencode/issue-orchestrator
  install -d -m 700 "$dst"
  # Consistent snapshot; .backup fails closed if the destination already exists.
  if [ -e "$src/orchestrator.sqlite3" ] && [ ! -e "$dst/orchestrator.sqlite3" ]; then
    sqlite3 "$src/orchestrator.sqlite3" ".backup \"$dst/orchestrator.sqlite3\""
  fi
  for item in agent-sessions tickets dod-reports; do
    if [ -e "$src/$item" ] && [ ! -e "$dst/$item" ]; then
      cp -a "$src/$item" "$dst/$item"
    fi
  done
'
```

Do not copy `orchestrator.sqlite3-wal` or `-shm` by hand next to a `.backup`
snapshot; that can pair files from different write generations. If you cannot
run `.backup`, stop all writers and copy the database together with its WAL/SHM
as one quiescent set, and verify it before starting the new worker. Preserve the
originals either way.

Copied `agent-sessions`, retained worktrees and run-once queue rows may contain
absolute session-log, worktree or repository paths from the old container.
Inspect them after the copy and rebind or deliberately abandon them; do not
assume they resume. The migration instructions are not a promise of general
resumability.

Do not delete `/home/dev/.config/issue-orchestrator` until the new unit has been
verified. The old directory is kept as a rollback copy and is intentionally not
touched by `init-state.sh`.

Migration is an explicit decision. If the legacy SQLite database exists and the
durable database is absent, preflight refuses to start instead of silently
creating an empty queue. After the copy above, set:

```sh
# /etc/issue-orchestrator/code-dev.env
ISSUE_ORCHESTRATOR_STATE_DECISION=migrated
```

`migrated` requires the durable database to exist. If you intentionally want a
fresh queue while keeping the old state for rollback, set
`ISSUE_ORCHESTRATOR_STATE_DECISION=fresh`. Never set `fresh` by accident when
the old database contains unfinished work.

### Enable at boot and verify

```sh
sudo install -m 0644 \
  deploy/systemd/issue-orchestrator-code-dev.service \
  /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now issue-orchestrator-code-dev.service

systemctl is-enabled issue-orchestrator-code-dev.service
systemctl is-active issue-orchestrator-code-dev.service
journalctl -u issue-orchestrator-code-dev.service -n 50 --no-pager
```

Confirm the router PID and that the host-side client is only a `docker exec`:

```sh
docker exec -u dev code-dev sh -lc '
  pid=$(cut -d" " -f1 /home/dev/.local/state/opencode/issue-orchestrator/router.pid)
  cat /home/dev/.local/state/opencode/issue-orchestrator/router.pid
  ps -o pid,ppid,pgid,sid,args -p "$pid"
'
```

The PID must be its own process-group and session leader. A second start
attempt is refused by the in-container flock, so a supervisor restart cannot
produce two routers.

### Update and rollback

The CLI runs from `ISSUE_ORCHESTRATOR_CHECKOUT` inside the container. Update
that checkout and build before restarting the unit:

```sh
docker exec -u dev -w /projects/issue-orchestrator code-dev \
  sh -lc 'git fetch origin main && git switch --detach origin/main && pnpm install --frozen-lockfile && pnpm build'
sudo systemctl restart issue-orchestrator-code-dev.service
```

`systemctl restart` invokes the graceful `ExecStop`, then preflight, then
`ExecStart`. It does not touch `code-dev`. Do not use `systemctl reload` for
this unit and do not `docker restart code-dev` to apply an orchestrator update.

To roll back the supervisor:

```sh
sudo systemctl disable --now issue-orchestrator-code-dev.service
```

That leaves `code-dev`, its volumes, the durable state directory, and the old
ephemeral directory intact. The previous manual router can then be started
again if needed.

If the container is recreated, the running `docker exec` dies; systemd restarts
the unit, and preflight waits for the new container. If the container is
removed or the compose stack is not started, the unit fails closed after its
start timeout and start-limit policy; start the container explicitly. The unit
never runs `docker start`, `docker compose up`, `docker restart`, or
`docker compose down`.
