# Provider ports and capabilities

The orchestration core selects three independent ports: a **Tracker** for work
items, a **CodeHost** for branches/change requests/reviews/checks/evidence, and
an **AgentRunner** for agent sessions. Adapters export a capability descriptor;
the descriptor is descriptive, not a permission to skip a gate. Calling a
missing operation throws `UnsupportedCapabilityError` and stops the workflow.

| Adapter | Port | Work items | Labels/comments | Change requests | Checks | Native approval | Merge | Evidence URLs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GitHub | Tracker | Yes | Yes | — | — | — | — | — |
| GitHub | CodeHost | — | Change comments | Yes (PRs) | Required checks | Yes | squash, merge, rebase | branch + raw URL |
| GitLab | Tracker | Stub; fails closed | Stub; fails closed | — | — | — | — | — |
| GitLab | CodeHost | — | Stub; fails closed | Stub; fails closed | Stub; fails closed | No | None | None |
| Jira | Tracker | Stub; fails closed | Stub; fails closed | — | — | — | — | — |
| Jira | CodeHost | — | Stub; fails closed | Not supported | Not supported | No | None | None |
| OpenCode | AgentRunner | — | — | — | — | — | — | Local CLI adapter; builder requires the preloaded OCI sandbox image |

Jira has no pull requests or checks. Pair it with a code host explicitly, for
example `"tracker": "jira", "code_host": "github"`; this is accepted by the
configuration schema, but Jira operations remain unavailable until its adapter
is implemented. The GitHub code host is not inferred from a Jira tracker.

## Configuration

The legacy `provider` key remains supported and selects both ports. New configs
may select them independently at the global, defaults, or repository level:

```jsonc
{
  "accounts": ["reisi007"],
  "tracker": "jira",
  "code_host": "github",
  "repos": {
    "reisi007/demo": { "account": "reisi007", "enabled": true }
  }
}
```

Repository-level values override defaults and global values. A repository's
legacy `provider` value fills either port that has no repository-level explicit
selection. The legacy `account` remains the fallback for both `tracker_account` and
`code_host_account`; those fields may be set independently when needed. Provider
credentials stay in the provider CLI/credential store, never in config.

The selected tracker/code-host pair is persisted with active work and checked
during recovery. Changing the pair while a journaled write is pending therefore
leaves the effect uncertain instead of replaying it against a different system.

## OpenCode AgentRunner

`AgentRunner` is an asynchronous port: `createSession`, `run`, `resume`,
`abort`, and `getResult` return promises. The OpenCode adapter invokes the
v2.2.6 CLI directly with `spawn` (no shell), `--standalone`,
`--format json`, `--auto`, a role-specific agent and the supplied model. Its
working directory, generated config, and captured NDJSON/stderr live in private
per-session directories beside the orchestrator runtime database, outside the
worktree. Those directories are forced to mode `0700`, log files to `0600`, and
log opens reject symlinks. OpenCode's resumable session/auth state remains in
the host `XDG_DATA_HOME`; the trusted control process retains `HOME` and that
data directory for saved model authentication. User config is isolated with a
private `XDG_CONFIG_HOME`, and the CLI starts outside the repository so project
config/plugins are not discovered. The generated agent config disables
configured plugins and MCP, and agent file access is restricted to the
worktree. Any machine-managed OpenCode configuration is administrator-owned and
must be trusted. Verifier shell is denied; builder shell runs in the OCI
sandbox without host home/data mounts or provider credentials.

Each completed agent must write `.issue-orchestrator/result.json` with exactly
these fields: `status` (`DONE`, `BLOCKED`, or `CHANGES_REQUIRED`), non-empty
`summary`, string arrays `changed_files`, `commands`, and `acceptance`,
`blocked_reason` (string or null), `evidence_dir` (string or null), and a
non-empty `verdict`. `BLOCKED` requires a reason; other statuses require a null
reason. Missing, malformed, or invalid files are failures, never success. A
timeout is recorded as `FAILED`; the runner sends SIGTERM to the process group
and escalates to SIGKILL after the configured grace period. A question-tool
  event is also terminated, in addition to the explicit V2 `question: deny`
  agent permission. Host-side Git commands all pass through the central Git
  helper, which overrides `core.hooksPath` with a private, empty runtime
  directory, disables `core.fsmonitor`, and discards environment-based
  command-scope Git config. Builder commits remain enabled; hooks are also
  disabled in the container as defense in depth. This prevents builder-written
  hooks and fsmonitor commands from running later with host authority during
  evidence publishing or worktree inspection.

Additive SQLite migrations store the external session ID, role, model,
worktree, lifecycle timestamps/status, validated result, event paths, reported
token/cost totals, and an atomic execution owner/60-second renewable lease. Only
one runner can claim a session at a time. Before a process runs unattended, its
PID, process-group ID, start identity, and per-execution environment token are
persisted. A private host supervisor waits for that durable identity handoff
before starting OpenCode; if the runner exits before handoff, it exits without
starting the agent, and if the runner exits afterwards, pipe closure stops the
execution group. A token-only startup intent is recoverable because no agent or
builder command can run before the handoff. Linux uses
`/proc`; macOS uses `ps` with a fixed C locale to read and
strictly validate PID/PGID/start-time/state fields and the exact token from the
process environment. On resume after an expired lease, the runner verifies and
stops the prior process group, then removes session-labeled OCI containers
before launching a replacement. Missing, mismatched, malformed, or inaccessible
identity fails closed and leaves the session non-terminal rather than risking a
signal to a reused PID or starting a duplicate. Other platforms are not
supported for execution. Triage, verifier, and reviewer cannot run shell
commands; they can write only the machine result file. Verifier never runs
repository scripts.

### Builder OCI sandbox

The OpenCode process remains trusted on the host. Builder shell commands are
handled by a generated custom shell executable configured with OpenCode V2's
`shell` field. The wrapper accepts only OpenCode's `-l -c <command>` form and
starts one disposable Docker/Podman container per command; all runtime options,
mounts, image ID, and container environment are generated by the host runner,
not from agent input. The container has `--network=none`, a read-only root,
`--cap-drop=ALL`, `no-new-privileges`, fixed CPU/memory/PID/file limits, and a
runtime-mapped unprivileged UID/GID. Its bind mounts are the job worktree
(read/write), that worktree's Git common directory (read/write for local
commits) with `.git/hooks` masked by a private empty read-only directory, both
the shared `config` and per-worktree `config.worktree` mounted read-only, plus
the `.git` worktree marker, `commondir`/`gitdir` pointers, and common
`worktrees` directory protected read-only. The selected worktree metadata
directory is mounted back read/write so Git can update its index and HEAD for
local commits. This prevents the builder from redirecting host Git to forged
metadata or persisting executable Git config such as `core.fsmonitor`. The
versioned host pnpm store at `/pnpm-store/v11` is read-only. The builder receives
no host home, provider credentials, SSH agent, OpenCode state, Docker/Podman
socket, or caller environment. The runner rejects nonstandard linked-worktree
metadata and Git configs containing embedded remote credentials or HTTP
authorization headers before mounting them.
The builder image contains Node 24, Git, and pnpm 11.23.0; Corepack keeps the
prepared package manager under `/opt/corepack`, verifies its version with
network access disabled, and remains offline at runtime. It does not install
`gh`/`glab`. Network isolation plus absent credentials/provider CLIs prevents
pushes and remote comments/merges. OpenCode's builder tools can read/edit only
the job worktree directly; the shell starts in `/workspace` inside the
container. The result contract names the absolute worktree result-file path.

The OCI sandbox's UID mapping supports Linux and macOS with numeric user IDs.
Rootful runtimes use the host UID/GID; on Linux, rootless runtimes use namespace
UID/GID 0, mapping to the unprivileged daemon owner. The sandbox fails closed
when runtime user-namespace status cannot be established.

Prepare the fixed image out of band before enabling builder work:

```sh
docker build -f sandbox/builder.Dockerfile \
  -t issue-orchestrator-builder:node24-pnpm11.23.0 .
```

At runtime the runner only inspects the exact preloaded image, pins its image
ID, and uses `--pull=never`; a missing runtime, image, pnpm store, or supported
linked-worktree layout fails closed. Containers carry generated session and
execution labels. Cleanup by session label occurs before a new process is
launched and after execution; if the runtime cannot confirm cleanup, the
persisted session remains non-terminal (`RUNNING`) rather than being reported
stopped.

An opt-in end-to-end commit check is available with
`ISSUE_ORCHESTRATOR_REAL_CONTAINER=1 pnpm test`. It requires the preloaded image
and an OCI daemon that can mount the test fixture path. It verifies offline
Node/pnpm and read-only store access, checks that host credentials, Docker/Podman
sockets, `gh`, and `glab` are absent, inspects the read-only root, attempts an
outside-worktree write against a host sentinel, and expects a dry-run push to a
reserved `.invalid` remote to fail before confirming the local commit. It also
attempts to modify the read-only shared and per-worktree Git configs, plants a
shared-Git `pre-push` hook, then confirms a later host-side push leaves the hook
inert. The default hermetic suite uses a fake runtime and needs no OCI daemon or
network.
This adapter does not add the orchestration loop tracked separately by issue #7.
