# issue-orchestrator

GitHub-only trusted-event router. The orchestrator filters configured authors,
persists issue-to-chat identity and event cursors, and forwards event IDs/URLs;
the ticket agent reads GitHub context itself and owns source changes, commits,
pushes, pull requests, comments, and follow-up issues.

OpenCode is the first intended agent backend, not a dependency of the core.

> **Status:** early `v0.1`. V1 routes GitHub issue and PR activity only.
> `trusted_authors` is a required allowlist for event routing; bot-authored and
> non-trusted activity is ignored. Provider permissions enforce merge limits.

## Requirements

- Node.js 24 or newer
- pnpm 11.23.0 (`packageManager` is pinned in `package.json`)
- `gh` authenticated to GitHub with the configured bot identity and permissions to read issues/PRs and perform the agent's intended GitHub work
- OpenCode CLI 2.2.6 for ticket-agent sessions; the agent runs directly in the existing Docker container with a private per-session copy of the configured `gh` auth, narrowed to the `github.com` host. The retained legacy `run --once` builder additionally requires the preloaded `issue-orchestrator-builder:node24-pnpm11.23.0` image
- `git` for source checkouts and the built-in OpenCode runner

V1 ticket intake is GitHub-only. GitLab/Jira adapters are not V1 providers.
The `command` AgentRunner is for a trusted installed executable implementing
the protocol in [`docs/providers.md`](docs/providers.md); it is supported on
Linux and macOS. Neither runner selection nor the `goal` command installs or
publishes an agent or CLI.

## Source-checkout quick start

```sh
git clone https://github.com/all-the-rest/issue-orchestrator.git
cd issue-orchestrator
pnpm install --frozen-lockfile
pnpm test
pnpm build
node dist/cli.js --help
node dist/cli.js setup --print
gh auth login --hostname github.com
gh auth status --hostname github.com
```

The test suite is hermetic: it uses fake provider CLIs and local repositories,
so tests need no network or credentials. CI runs the suite on Linux and macOS.
Run the CLI from this checkout with `node dist/cli.js`; npm installation and
standalone binaries are not available.

Copy the synthetic example to the private default config location, then edit
its model, GitHub account, and repository fields to match a repository you can
access. The placeholder project is disabled; set `enabled: true` only after
replacing the sample identity and confirming the provider permissions.

```sh
install -d -m 700 "$HOME/.config/issue-orchestrator"
install -m 600 examples/config.jsonc "$HOME/.config/issue-orchestrator/config.jsonc"
${EDITOR:-vi} "$HOME/.config/issue-orchestrator/config.jsonc"
```

The configured `account` must match `gh auth status`; the account needs access
to the configured project. Ticket-agent sessions require the built-in `opencode`
runner. Configure model-provider auth separately; only the legacy `run --once`
builder needs its OCI image. Other workflows may select `agent_runner:
"command"` and configure a trusted executable and argv; see the protocol in
[`docs/providers.md`](docs/providers.md#runner-selection). The command runs as
the current OS user, so provider permissions and its credential setup are the
operator's responsibility.

Run `issue-orchestrator goal` or `issue-orchestrator tickets poll` from a
checkout of the configured target project:
the CLI verifies that the checkout's `origin` matches `--project` and gives
that workspace to the ticket agent. Use a dedicated checkout/container for
unattended work. The orchestrator source checkout and target project checkout
can be different. For example, after cloning the configured target repository:

```sh
ORCHESTRATOR_CHECKOUT="$HOME/src/issue-orchestrator"
cd "$HOME/src/your-project"
umask 077
goal_file="$(mktemp /tmp/issue-orchestrator-goal.XXXXXX)"
trap 'rm -f "$goal_file"' EXIT
${EDITOR:-vi} "$goal_file"
node "$ORCHESTRATOR_CHECKOUT/dist/cli.js" goal \
  --project owner/repository \
  --issue 123 \
  --goal-file "$goal_file"
```

Replace the checkout, project, and issue with values in the config. Ticket
events are routed only for configured trusted authors. The `goal` command can
add private operator acceptance criteria, but neither command fetches or copies
ticket/comment bodies into the event payload. The agent reads issue and PR content itself, makes and
publishes changes with `gh`, and asks via a GitHub comment if it needs a human
decision; the router resumes it on a trusted reply. For manual mode, remove
merge authority from the agent's provider credentials or enforce it with
protected branch/ruleset policy—prompt text alone cannot restrict the agent.

The runtime database contains event identities/cursors, optional private
operator acceptance criteria, and runner/session metadata. Protect the runtime
home and use a dedicated OS identity and least-privilege credentials. See the
[`threat model`](docs/threat-model.md#v1-ticket-to-agent-boundary) before
enabling an agent on a real repository.

The required main-branch checks, local Ratchet command, and baseline review
policy are documented in [`docs/quality-gates.md`](docs/quality-gates.md).

## Usage

```sh
issue-orchestrator status
issue-orchestrator doctor --json
issue-orchestrator setup --print
issue-orchestrator jobs list --json
issue-orchestrator jobs show <id> --json
issue-orchestrator jobs retry <id>
issue-orchestrator jobs cancel <id>
issue-orchestrator logs [--job <id>] [--follow] [--json]
issue-orchestrator project add <id> --from <existing>
issue-orchestrator project pause|resume|remove <id>
issue-orchestrator list
issue-orchestrator goal --project <owner/repo> --issue <number> --goal-file <private-file|->
issue-orchestrator tickets poll [--project <owner/repo>] [--dry-run] [--max <n>]
  [--quiet-period-ms <n>] [--intake-poll-ms <n>] [--max-concurrency <n>]
  [--delivery-timezone <IANA>] [--delivery-window <spec>] [--delivery-cooldown-ms <n>] [--delivery-24-7]
  [--delivery-reconfigure]
issue-orchestrator run --once [--project <owner/repo>] [--dry-run] # legacy workflow
issue-orchestrator claim <project> <issue>
issue-orchestrator checkpoint <stage> --owner-token <token>
issue-orchestrator dod verify <project> <issue> --owner-token <token> [--plan]
  issue-orchestrator evidence <project> <issue> --dir <dir> --owner-token <token>
  issue-orchestrator capture --output <file> -- <command> [args...]
issue-orchestrator release --owner-token <token>
```

Run `issue-orchestrator --help` for the full command list. All commands accept
`--config <path>`; read commands accept `--json`. The current operator CLI
diagnostics and persisted-job read schemas are documented in
[`docs/operator-cli.md`](docs/operator-cli.md).
V1 responsibilities, configuration, provider behavior, and security boundaries
are described in [`docs/architecture.md`](docs/architecture.md),
[`docs/config.md`](docs/config.md), [`docs/providers.md`](docs/providers.md),
and [`docs/threat-model.md`](docs/threat-model.md). A synthetic GitHub-only
configuration and sample project are in [`examples/`](examples/).
OpenCode V2 users can load the optional thin wrapper in
`.opencode/skills/issue-orchestrator/SKILL.md`; the CLI remains the workflow implementation.
Run `issue-orchestrator setup --print` for the agent-consumable setup checklist;
it is static, reads no config, writes nothing, and does not install a skill or
slash command.
The project ships no OpenCode `/goal` slash-command override, so OpenCode's
built-in `/goal` command keeps working unchanged. Use the dedicated
`issue-orchestrator goal` CLI command instead: optionally write acceptance text
to a private file (mode `0600`), then run
`issue-orchestrator goal --project owner/repo --issue 123 --goal-file /private/path`.
Use `-` to read criteria from stdin. The CLI bounds input to 32 KiB; it is
forwarded separately from GitHub event identities and bodies are still read by
the agent.
`capture` runs argv directly with `shell: false`, tees stdout/stderr to the
terminal and a new output file, and writes a JSON sidecar with the exact argv and
exit status; it uses Node streams and does not depend on platform-specific
`script` flags.

`tickets poll` discovers open issues authored by configured `trusted_authors`
and routes trusted ticket comments plus PR conversation/review events to each
issue's persistent OpenCode chat. The agent reads full context using `gh`; the
router sends event IDs and URLs only, posts no status/question comments, and
does not claim it observed CI. Configure `tickets.bootstrap` to select the
ordered messages used for both initial and update turns. `tickets.delivery`
optionally limits automated dispatches to weekly windows in an explicit IANA
zone and adds a global start-to-start cooldown that gates every bootstrap and
follow-up dispatch; there is no default window, so without it polling stays
24/7 with cooldown disabled. A changed cooldown is adopted explicitly with
`tickets poll --delivery-reconfigure` while no ticket session is active, which
preserves the last-start anchor but applies the new interval immediately.
`goal` intentionally bypasses both windows and the cooldown. Outside a window
only metadata IDs/URLs, author/timestamps and per-category counts are persisted
and delivered later; event bodies are never fetched for routing.
The ticket agent may
delegate bounded implementation work to one `build-worker` subagent; both the
parent and the delegated worker keep the `question` tool denied. The worker
shares the ticket agent's worktree, container, network, and GitHub credential
authority, so it is not a separate sandbox. Question/reply cycles use GitHub
comments and the same chat.
Ticket sessions are bounded by the global `tickets.max_concurrency` (default
`1`) and run in parallel across distinct issues. Follow-up events are grouped
per issue for `tickets.quiet_period_ms` (default `60000`, `0` disables); the
durable batch and deadline survive restarts, and capacity pressure defers work
without losing events. Polling continues intake for other issues and newly
opened tickets while a long turn runs; the running issue's exclusive lease defers
its own intake until that turn and its pending turn are delivered, then collects
from the same durable cursor. Delivery
is at-least-once, so a crash after dispatch may replay a turn; agent-side effects
must be idempotent.

`run --once` is retained as a separate legacy orchestration workflow; it is not
the implementation behind the `goal` command. It atomically resumes a claim
only after its recorded owner process is
no longer live, or selects one open issue from enabled repositories, ordered by
configured severity and age, and skips issues without a configured trusted
author. It isolates work in a private runtime Git worktree, runs triage,
baseline and after verification, an OCI-isolated builder,
the configured DoD commands, evidence publication, and an independent review.
The issue body or the configured trusted triage comment is passed to agents as
acceptance data, not executable instructions. Use `--project` to restrict issue
discovery. `--dry-run` prints the selected issue and plan without opening or
mutating SQLite, claiming work, creating a branch, or writing to GitHub.
Each worker must run from a checkout whose `origin` matches its selected code
host project; run workers from separate matching checkouts for distinct projects.

Scheduling is database-global across every config sharing
`ISSUE_ORCHESTRATOR_HOME`:
`max_concurrency` defaults to `1`. Set it to a positive integer to allow up to
that many runs, and optionally set `repos.<project>.max_concurrency` as an
additional per-project cap no greater than the global cap. A project can reserve
named `resource_locks` (for example `["browser"]`, `["build"]`, or `["encode"]`)
so jobs requiring the same scarce resource queue transactionally. Concurrent
Configurations using one runtime home must agree on the global cap. Configurations
with active jobs for the same project must also agree on its project cap. More agents
increase model/API spend and provider rate-limit use approximately with active agent count: at `N`
concurrent runs, expect up to roughly `N` times the per-run model/API demand and
more simultaneous provider calls. Configure caps according to provider quotas and
budget; concurrency does not increase any provider's rate limit.

For GitHub projects, use a consistent repository spelling across configurations.
Case variants identify the same repository for active-claim checks; if an older
work item exists under another spelling, a new claim is refused rather than
silently creating a second workflow or resetting its retry history.

```jsonc
{
  "max_concurrency": 2,
  "repos": {
    "owner/repo-a": { "max_concurrency": 1, "resource_locks": ["browser"] }
  }
}
```

Possible JSON outcomes include `NO_ISSUE`, `DRY_RUN`, and `DONE`; `REVIEW`,
`BLOCKED`, and `NEEDS_INFO` hand the issue back for human action. Handover
preserves the branch/worktree and releases the queue claim. Unexpected failures
or unavailable dependencies fail closed and retain the active claim and
artifacts for recovery. Automatic merge is attempted only when enabled and
after the existing exact-head native-approval, machine-marker, DoD, and required
check gates pass. Auto-merge defaults to true for enabled projects; set
`auto_merge: false` to hand off for human review instead.

For user-level launchd/systemd timers, Docker operation, persistence, and
shutdown/recovery behavior, see [`docs/service.md`](docs/service.md). For a
separate worker container or supervision inside an existing Docker `code-dev`
container, see [`deploy/README.md`](deploy/README.md).
The dispatcher topology and event-delivery idempotency contract are recorded in [`docs/agent-dispatch.md`](docs/agent-dispatch.md).
For safe OpenCode context transfer between implementation sessions, see
[`docs/session-handoff.md`](docs/session-handoff.md).

Exit codes: `0` command completed (including a `REVIEW` ticket handoff), `1`
refused/failed or a pending status write, `2` config missing or invalid, and `8`
checks pending on the legacy `run --once` path.

Configuration lives in `~/.config/issue-orchestrator/config.jsonc` unless
`ISSUE_ORCHESTRATOR_CONFIG` or `--config` points elsewhere. Runtime data lives
in `orchestrator.sqlite3` under `ISSUE_ORCHESTRATOR_HOME`; all configs share
that transactional queue. Existing `state.json` and `lock.json` files are
imported once on first use. SQLite uses WAL, foreign keys,
and a busy timeout; work claims and event enqueueing are transactional. The
additive schema migration stores guarded workflow state separately from the
queue/lease state, with an actor/reason transition log and a durable
side-effect intent/result journal. Existing checkpoint stages are mapped during
migration.
The CLI claim records only `CLAIMED`; `checkpoint triaged` is the agent's
explicit progress report and advances the workflow before isolation.
If a legacy `lock.json` is malformed, normal commands fail closed; after
verifying the old run has stopped, `release --force --confirm-stale` archives
the malformed lock and matching state file instead of deleting them.

GitHub label/comment, change-request, merge, and evidence writes are journaled
before execution. Resume paths inspect the corresponding live tracker state or
remote evidence branch before retrying; an unknown external result fails closed
instead of blindly repeating a write. Evidence branches use stable
job-scoped idempotency keys and are validated against their remote manifests.
Every CLI startup, including `status`, reaps expired leases and inspects pending
journal entries; it never repeats an unverified provider write. For a verified
merged PR whose workflow finalization crashed, recovery retains a job owner,
journals the working-to-done label updates, and clears the queue only after
those updates are confirmed. Thus `status` may make these journaled tracker
updates. An unavailable provider leaves recovery active for retry. Other
confirmed effects are marked complete, absent effects stay pending for their
owning command to resume, and unavailable or mismatched observations are marked
uncertain and shown by `status`. A normal merge keeps its lock for
`release --result done`.
Comment recovery requires both the
configured actor and an exact hash of the rendered comment. Label setup repairs
existing color/description drift. Evidence inspection requires a matching local
Git worktree/origin; without one, the result stays uncertain for recovery from
the owning worktree. Evidence intents pin the locally prepared manifest/file
hashes and a random job-specific branch suffix, so a self-consistent but
unrelated ref is not adopted. PR reuse inspects all states and refuses lookups
that reach its 1,000-result safety cap rather than assume the match set is
complete. Provider ports, capability descriptors, configuration, and the
support matrix are documented in [`docs/providers.md`](docs/providers.md).
Actor values guard internal transitions, but they are local process roles, not
cryptographic identities; trusted human approval is established from the
configured GitHub reviewer checks.

## Project Definition of Done

Every repository must explicitly configure all five command categories, its
required CI check names, evidence class, and acceptance source:

```jsonc
{
  "repos": {
    "acme/service": {
      "account": "acme-bot",
      "dod": {
        "commands": {
          "build": ["pnpm", "build"],
          "test": ["pnpm", "test"],
          "lint": null,
          "typecheck": ["pnpm", "typecheck"],
          "security": null
        },
        "required_checks": [
          "test (ubuntu-latest)",
          "test (macos-latest)",
          "docker-image",
          "service-linux-container",
          "gitleaks"
        ],
        "evidence_class": "cli",
        "acceptance_source": "issue_body",
        "timeout_ms": 300000
      }
    }
  }
}
```

Command values are argv arrays executed directly with `shell: false`; `null`
explicitly skips a category. Omitted categories, empty/invalid argv, empty or
duplicate required checks, and unsupported enum values fail closed. `timeout_ms`
is optional (default 300000) and bounded to one hour. `dod verify` checks the
active issue lock, branch, clean worktree, and exact full head SHA before running
every configured command. It captures bounded stdout/stderr, exit code, signal,
and timeout status. `--plan` executes nothing and marks configured commands as
planned; skipped categories remain distinct. Reports are written privately to
the runtime directory; optional `--report <path>` must be outside the worktree.

For `acceptance_source: "triage_comment"`, exactly one issue comment must
contain `<!-- issue-orchestrator:acceptance -->` and be authored by a configured
trusted author. The text is recorded as data, never treated as instructions.
Evidence publication requires a successful, current, exact-head execution
report. The schema-2 manifest includes its evidence class and report; the issue
receives a journaled proof comment with SHA-pinned before/after artifact links,
commands/results, the evidence commit, exact source head, and change-request
link. Merge separately requires the nonempty provider-required check set plus
all configured required check names to be green. `auto_merge` defaults to true
for enabled projects; set it to false to opt out. Because this enables automatic
merge behavior, configure server-side branch protection/rulesets with required
CI and trusted approval rules. The CLI cannot replace those controls. Binary evidence and
customer-data evidence require manual inspection. See [`SECURITY.md`](SECURITY.md)
and the [unattended-run threat model](docs/threat-model.md).

## Architecture

```
src/cli.ts        argument dispatch, --help/--version
src/core/         commands, config, SQLite persistence and migrations
src/providers/    Tracker/CodeHost/AgentRunner ports and provider adapters
src/git/          isolated Git process and origin operations
src/evidence/     artifact validation, secret scanning, evidence publishing
```

The roadmap and architecture decisions live in the pinned issue on GitHub.

## License

Apache-2.0
