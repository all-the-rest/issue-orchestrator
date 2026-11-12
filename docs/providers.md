# Provider ports and capabilities

The retained legacy workflow selects a **Tracker** for work items and a
**CodeHost** for branches/change requests/reviews/checks/evidence. The V1
ticket-to-agent path uses one task-facing **Ticket** port plus the replaceable
**AgentRunner** for sessions. Adapters export a capability descriptor;
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
| GitHub | Ticket | Issue routing metadata | Ticket comments and PR conversation/inline/review cursors; legacy status API | — | — | — | — | — |
| OpenCode | AgentRunner | — | — | — | — | — | — | Local CLI adapter; builder uses OCI, ticket-agent runs in-container with private `gh` auth narrowed to the `github.com` host |
| Command | AgentRunner | — | — | — | — | — | — | Trusted installed executable using versioned JSON stdio |

## Runner selection

Runner selection can be set globally with `agent_runner` (or
`defaults.agent_runner`) and overridden for an individual project with
`repos.<owner>/<repo>.agent_runner`. Precedence is repository, top-level,
`defaults`, then `opencode`. `command_runner` follows the same precedence and
contains trusted executable/argv/timeout settings. For example:

```jsonc
{
  "agent_runner": "opencode",
  "model": "provider/model",
  "command_runner": { "executable": "/opt/agents/project-agent", "args": ["--stdio"] },
  "repos": { "owner/repo": { "agent_runner": "command", "command_runner": { "executable": "/opt/agents/owner-agent" } } }
}
```

The selected runner name is stored on every agent session. Recovery verifies
that identity before reading results, resuming, or aborting a session; changing
the configured runner while a job is active therefore fails closed. Existing
SQLite databases migrate additively and identify pre-migration sessions as
`opencode`, the prior default runner. The `model` remains independently
configurable and is passed to the selected adapter. OpenCode remains the
default. The `command` adapter invokes a trusted installed executable directly
(never through a shell) using protocol `issue-orchestrator.agent-runner/v1`.
Each request is `{protocol, request_id, operation, session_id, system_prompt,
input}` with operations `createSession`, `run`, `resume`, `abort`, and
`getResult`. `system_prompt` is distinct from structured user `input`; older
callers may continue to provide `prompt`, which is carried as user input.
Responses
must be one JSON object with the same protocol; creation returns `session_id`,
and result operations return a result conforming to shared `AgentResult`.
Output is limited to 1 MiB and calls time out after 30 minutes by default
(configurable up to one hour). Executable and argv come only from trusted global
or per-project config, never ticket data. The child receives only PATH,
locale, temp and Windows platform variables; host HOME/XDG paths, GitHub tokens,
SSH-agent state, and unrelated host credentials are excluded. The installed executable must
obtain approved auth through its own credential mechanism. Stderr is discarded
and diagnostics are generic/redacted. This adapter only hands off structured
data; it does not perform source, CI, PR, evidence, or merge operations, nor
enforce merge policy. It is not supported for the `ticket-agent` role because
that role requires the private GitHub CLI auth handling of the OpenCode runner.
Actual merge enforcement belongs to the selected project/provider.

The test suite includes an in-memory reference runner to exercise the basic
port and shared result contract. It is test-only: it provides no isolation,
credential boundary, durable recovery, timeout, or cancellation guarantees and
is not selectable in production. Existing `agent_sessions` rows still persist
OpenCode runtime details (private NDJSON/stderr paths, OCI identity, and
process/lease recovery identity) alongside generic runner identity. These
fields remain owned by the OpenCode adapter; they have not been generalized
into an adapter-neutral persistence model.

Jira has no pull requests or checks. Pair it with a code host explicitly, for
example `"tracker": "jira", "code_host": "github"`; this is accepted by the
configuration schema, but Jira operations remain unavailable until its adapter
is implemented. The GitHub code host is not inferred from a Jira tracker.
Those adapters belong to the older broad workflow; V1 ticket intake is GitHub-only.

## V1 ticket-to-agent path

`goal` and `tickets poll` use a route-only event envelope containing repository,
issue/PR/comment IDs and URLs. The router does not read or copy issue/comment
bodies into the agent payload. The ticket-agent fetches full issue/PR context
with `gh`, then owns source edits, commits, pushes, PRs, comments, and linked
follow-up issues. It may delegate bounded implementation work to the dedicated
`build-worker` subagent; the worker runs in the same worktree and container,
uses the ticket session's configured model, cannot ask questions or launch
further subagents, and shares the parent's trusted shell, network, `gh`, and Git
credential authority. That shared authority is deliberate: shell permission
patterns and result-file edit rules are defense in depth, not isolation, and an
instruction not to publish is not an enforced boundary. Delegate only work the
parent could perform itself. Optional operator acceptance criteria passed to
`goal` remain separate from GitHub event data.

The router admits only configured trusted authors, excludes the authenticated
bot/tool accounts, and stores separate durable cursors for ticket comments and
PR conversation, inline review, and review submission state. Review cursors also
retain observed pending review ids and a `submitted_at` watermark with the ids
already seen at that exact second, so a draft created before later reviews but
submitted afterwards — including in the same second as the watermark — is
delivered instead of being skipped by the numeric cursor. Agent-reported
same-repository PR references associate follow-up events with that ticket's
existing chat; the router does not infer association from ticket text or publish
status comments. `question` is denied on the ticket agent and on every delegated
subagent: the agent asks in a GitHub comment, stops, and resumes after a trusted
reply. `--retry-blocked` explicitly continues the persisted conversation after
local remediation.

The Ticket adapter provides routing metadata, paginated event sources and
legacy read/status operations. The ticket router uses metadata and cursors only;
it does not use the provider's status-comment publishing method. GitLab, Jira,
and remote event/webhook ingress remain outside V1.

## Configuration

The legacy `provider` key remains supported and selects both ports. New configs
may select them independently at the global, defaults, or repository level:

```jsonc
{
  "accounts": ["example-bot"],
  "tracker": "jira",
  "code_host": "github",
  "repos": {
    "example-org/demo": {
      "account": "example-bot",
      "enabled": true,
      "dod": {
        "commands": {
          "build": ["pnpm", "build"],
          "test": ["pnpm", "test"],
          "lint": null,
          "typecheck": ["pnpm", "typecheck"],
          "security": null
        },
        "required_checks": ["CI"],
        "evidence_class": "cli",
        "acceptance_source": "issue_body"
      }
    }
  }
}
```

Repository-level values override defaults and global values. A repository's
legacy `provider` value fills either port that has no repository-level explicit
selection. The legacy `account` remains the fallback for both `tracker_account` and
`code_host_account`; those fields may be set independently when needed. Provider
credentials stay in the provider CLI/credential store, never in config.
For a Jira tracker project paired with a GitHub code host, set
`repos.<jira-project>.code_host_project` to the GitHub `owner/repository`; issue
tracking remains keyed by the Jira project while evidence branches and immutable
raw links are written to that configured GitHub repository.

Every project must provide `dod.commands.build`, `test`, `lint`, `typecheck`,
and `security`. Each is either a nonempty argv array or explicit `null` to skip;
commands run without a shell. `dod.required_checks` is a nonempty array of
unique exact check names, and merge requires both the provider's nonempty
required-check result and each configured name to be green. `evidence_class` is
exactly `ui`, `cli`, or `docs`; `acceptance_source` is exactly `issue_body` or
`triage_comment`. The optional `timeout_ms` is a positive integer no greater
than 3600000 (default 300000).

`issue-orchestrator dod verify <project> <issue> --owner-token <token>` checks
the active issue worktree and exact checkpointed head before executing all
configured argv commands. `--plan` performs the same binding checks but runs no
commands. Reports distinguish executed, planned, and skipped gates and contain
bounded stdout/stderr, exit status, timeout/signal, acceptance text, and the
DoD-config digest. Triage acceptance must come from exactly one comment bearing
`<!-- issue-orchestrator:acceptance -->` by a configured trusted author; its
contents are data, not agent instructions.

Evidence manifest schema 2 records the configured evidence class and successful
DoD report in addition to project/issue/change/head and Git blob SHA plus SHA-256
artifact hashes; SHA-256 is rechecked against fetched artifact contents. Older
schema-1 evidence is deliberately rejected for publication recovery and merge;
an existing schema-1 intent is not silently adopted and needs explicit recovery.
After publication the issue gets
a journaled human-readable proof comment with before/after SHA-pinned artifact
links and command results. Machine gate markers remain on the change request.

The selected tracker/code-host pair is persisted with active work and checked
during recovery. Changing the pair while a journaled write is pending therefore
leaves the effect uncertain instead of replaying it against a different system.

## `run --once`

The first end-to-end orchestration path is `issue-orchestrator run --once`.
It resumes an active claim or discovers one trusted open issue across enabled
repositories (optionally restricted with `--project`), then uses the configured
OpenCode `AgentRunner` in a private runtime worktree. The path runs triage,
before/after read-only verification, an isolated builder, configured DoD argv
gates, journaled branch push and change-request creation/reconciliation,
evidence publication, and independent review. Acceptance text selected by
`dod.acceptance_source` is supplied as serialized data, never as agent
instructions; all issue/comment text remains explicitly untrusted.

`--dry-run` reports the selected issue and intended gates without opening or
mutating SQLite, acquiring a claim, creating a branch, or writing to the
provider. Terminal outcomes are `DONE`, `REVIEW`, `BLOCKED`, and `NEEDS_INFO`;
human handovers preserve the worktree and release the job's queue claim. Unexpected
errors, mismatched state, and unavailable builder/runtime dependencies fail
closed and retain the claim and recovery artifacts. Merge is delegated to the
existing gate when `auto_merge` is enabled (the default for enabled projects); it still requires trusted
native approval on the exact head, exact-head machine markers, and every
provider/configured required check to pass. With `auto_merge` disabled, a
review handover is posted instead. Set `auto_merge: false` at the repo or
defaults level to opt out. Server-side branch protection/rulesets with required
checks and trusted approval rules remain strongly recommended operational
controls; the CLI does not assume or prove that they are enabled.

This vertical slice currently has end-to-end support for GitHub and the
OpenCode runner. GitLab and Jira remain fail-closed stubs; this does not imply
that their adapters can run the workflow.

## OpenCode AgentRunner

`AgentRunner` is an asynchronous port: `createSession`, `run`, `resume`,
`abort`, and `getResult` return promises. The OpenCode adapter invokes the
v2.2.6 CLI directly with `spawn` (no shell), `--standalone`,
`--format json`, `--auto`, the configured default agent, and the supplied model. Its
working directory, generated config, and captured NDJSON/stderr live in private
per-session directories beside the orchestrator runtime database, outside the
worktree. Those directories are forced to mode `0700`, log files to `0600`, and
log opens reject symlinks. The process gets private `HOME` and XDG directories.
The operator's OpenCode `auth.json` must be a private, regular, owned file.
Legacy provider maps are copied into the session data directory; OpenCode V2
`auth export` arrays are narrowed to the active credential for the selected
model provider and imported with `opencode auth import` into that session's
private SQLite database. The host data path is not exposed. Provider
credentials remain in the private session directory for crash resume, and their
values are redacted from persisted logs. For V2, provision only the selected
provider, for example by redirecting `opencode --standalone auth export openai`
into the private `$XDG_DATA_HOME/opencode/auth.json` used by the orchestrator
(do not set that `XDG_DATA_HOME` on the export command unless it points to the
authenticated OpenCode database). Keep the directory mode `0700` and file mode
`0600`. Use a dedicated/disposable operator account with least-privilege
model-provider credentials. User config is isolated with a private
`XDG_CONFIG_HOME`, and the CLI starts outside the repository so project
config/plugins are not discovered. The generated agent config disables
configured plugins and MCP, and agent file access is restricted to the
worktree. OpenCode is started without a CLI `--agent`: the runner uses the
configured `default_agent`, falling back to OpenCode's built-in `build`, then
overlays the role's system instructions and permissions on that agent. It keeps
other selected-agent settings, but forces primary mode and replaces permissions
with the runner's role boundary. Any machine-managed OpenCode configuration is
administrator-owned and must be trusted. Verifier shell is denied; builder
shell runs in the OCI sandbox without host home/data mounts or provider
credentials.

Each completed agent must write `.issue-orchestrator/result.json` with exactly
these required fields: `status` (`DONE`, `BLOCKED`, `CHANGES_REQUIRED`, or
`NEEDS_INFO`), non-empty
`summary`, string arrays `changed_files`, `commands`, and `acceptance`,
`blocked_reason` (string or null), `evidence_dir` (string or null), and a
non-empty `verdict`. `BLOCKED` and `NEEDS_INFO` require a reason; other statuses
require a null reason. After validation, the runner removes this transient
result file so it does not become an extra repository change. An optional
`references` array may contain up to 20
structured same-repository GitHub pull-request or checks URLs. The bridge
validates their host, path shape, and repository before including at most five
in a status comment; it labels them agent-provided and does not verify their
existence or check state. Missing, malformed, or invalid files are failures,
never success. A
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
The adapter is used by the `run --once` orchestration path described above.
