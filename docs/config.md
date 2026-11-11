# Configuration

This page describes the JSONC config used by the GitHub V1 ticket-to-agent path
and the retained legacy `run --once` workflow. See
[`architecture.md`](architecture.md) for the responsibility split.

## Location and format

By default config is `~/.config/issue-orchestrator/config.jsonc`. Set
`ISSUE_ORCHESTRATOR_CONFIG` or pass `--config <path>` to select another file.
The parser accepts JSONC line/block comments and trailing commas. Credentials
belong in the provider credential store, not this file; credential-like fields
and known token values are rejected.

## Current schema

The following is a shape overview, not a complete copy-paste config. `model`
and a nonempty `repos` object are required. Every repository requires `dod`
with all five command categories, a nonempty unique list of exact required
check names, an evidence class, and an acceptance source. See
[`providers.md`](providers.md) and the README's [DoD example](../README.md#project-definition-of-done)
for current behavior and examples.

Top-level fields:

- `model`: required `provider/model` string.
- `repos`: required nonempty object keyed by `owner/repository`.
- `agent_runner`: optional selected AgentRunner name; defaults to `opencode`.
- `command_runner`: optional trusted executable configuration used when
  `agent_runner` is `command`; fields are `executable`, optional `args`, and
  optional `timeout_ms` (default 30 minutes, maximum one hour).
- `accounts`: optional unique account-name array; an enabled repo needs an
  account, selected from its `account` or the first configured account.
- `trusted_authors`: optional username array.
- `tool_authors`: optional usernames to exclude from ticket comment inputs (the
  configured GitHub accounts are excluded automatically).
- `tickets`: optional ticket handoff settings. `bootstrap` is an ordered,
  non-empty array of turn instructions; each entry becomes one turn in the same
  agent session, so the message count is the list length. The default is a
  two-message sequence: review and plan first, implement second. `system_prompt`
  optionally replaces the stable agent system prompt. Ticket-agent execution
  requires the OpenCode runner so it can use the private GitHub CLI login.
  `tickets.max_concurrency` is the global cap on simultaneously active ticket
  sessions (default `1`); it is valid only at the top level and is enforced
  atomically across pollers and restarts. `tickets.quiet_period_ms` is the
  coalescing window for events of one issue (default `60000`, `0` disables
  coalescing). It may be overridden per repository with
  `repos.<project>.tickets.quiet_period_ms`. `tickets.intake_poll_ms` sets the
  background intake cadence while an agent turn runs (default `30000`, minimum
  `1000`), and may also be tuned per repository. `tickets.post_merge_poll_ms`
  is the minimum interval between polls of one merged/closed pull request
  conversation (default `300000`, `0` polls every turn). `tickets.post_merge_poll_limit`
  bounds how many retained PRs are polled per turn (default `2`, range `1..20`);
  rotation by last poll time means older PRs are delayed, never abandoned.
  `tickets.delivery` optionally restricts automated dispatches to weekly windows
  in an explicit IANA zone and sets a global start-to-start cooldown; see
  [Delivery windows and global cooldown](#delivery-windows-and-global-cooldown).
  There is no default window: without `tickets.delivery` the router runs 24/7
  with cooldown disabled.
  Precedence is
  `defaults.tickets` < top-level `tickets` < `repos.<project>.tickets`; the
  global cap cannot be overridden per repository, and a repository-level
  cooldown is only accepted when every polled project resolves the same value.
- `max_concurrency`: optional positive integer (default `1`) for the retained
  `run --once` builder scheduler. Ticket sessions use `tickets.max_concurrency`.
- `provider`, `tracker`, `code_host`: legacy workflow provider selectors
  (`github`, `gitlab`, or `jira`). Legacy `provider` selects both tracker and
  code host; they may instead be selected independently. The V1 `goal` command
  requires the GitHub tracker.
- `defaults`: optional defaults object. `enabled` (default true),
  `local_only` (default false), `auto_merge` (default true), provider and agent
  runner selectors, `command_runner`, and label mappings can be set here.
- `labels`: optional label-name mapping.
- `merge.method`: optional `squash`, `merge`, or `rebase` (default `squash`).
- `evidence.branch_prefix`: optional safe branch prefix (default
  `agent-evidence`).

Repository fields include `account`, `tracker_account`,
`code_host_account`, `provider`, `tracker`, `code_host`, and
`code_host_project`; `enabled`, `local_only`, and `auto_merge` booleans;
`base_branch` (default `main`); `trusted_authors`; `tool_authors`; `labels`;
`agent_runner`; `command_runner`;
`workspace` (project checkout used by ticket-agent sessions); `tickets`
(per-repository overrides of the `tickets` settings above);
`max_concurrency`;
`resource_locks`; `merge_method`; `evidence.branch_prefix`; and required `dod`.
Repository values override applicable defaults/global provider selections.
The legacy repo `provider` fills either port that has no more specific
selection. Account credentials are not stored in config.

`dod.commands` has `build`, `test`, `lint`, `typecheck`, and `security`, each a
nonempty argv array or `null` to skip; commands run without a shell.
`dod.required_checks` is a nonempty unique array of check names.
`dod.evidence_class` is `ui`, `cli`, or `docs`; `dod.acceptance_source` is
`issue_body` or `triage_comment`; optional `dod.timeout_ms` is an integer from
1 through 3,600,000 (default 300,000). For `triage_comment`, current behavior
requires exactly one marked acceptance comment from a trusted author.

`tickets poll` requires a non-empty `trusted_authors` allowlist at the global or
repository level; repository values replace the global list. It discovers
trusted issue authors, then routes only trusted ticket/PR events. The authenticated
bot and configured `tool_authors` are always filtered out. `workspace` may also
be specified as `tickets.workspace`, but not both ways for one repository.

Follow-up events are grouped per issue. The first observation starts a durable
batch; every new event identity extends the deadline to
`quiet_period_ms` after the latest observation. Cursor, event identities and
deadline are committed together before any agent dispatch, so a crash or restart
neither loses nor duplicates the burst. A poll only delivers a batch after its
deadline and only while a global session slot is free. Capacity pressure leaves
the batch and cursor untouched for the next poll. The batch is never truncated;
all distinct event IDs are forwarded in stable creation order. Because dispatch
happens on a poll, the effective debounce latency also includes the worker poll
interval; keep `ISSUE_ORCHESTRATOR_INTERVAL_SECONDS` at or below the configured
quiet period for prompt delivery.

Pollers may overlap or run in separate containers sharing
`ISSUE_ORCHESTRATOR_HOME`. One SQLite transaction admits sessions and counts a
durable pending batch as owning its issue, so `goal` and `tickets poll` (or two
workflow keys) cannot run the same issue chat at once. GitHub repository IDs are
case-insensitive, so spelling aliases also share the same persisted job,
session, issue lock and worktree. The global cap is persisted in SQLite: while sessions are active, a
poller configured with a different `tickets.max_concurrency` fails closed instead
of enforcing a private limit.

Ticket ownership uses a durable lease with periodic heartbeat, not PID identity
alone. A same-namespace dead process may be reclaimed early; foreign or unknown
PID-namespace owners fail closed until their lease expires. State writes are
owner compare-and-swap, so a worker that lost its lease cannot overwrite newer
events.

Merged and closed associated pull requests stay tracked. Their conversation,
inline review comments and reviews continue to be routed to the same ticket
session, including after the issue itself closes; closed issues with tracked
associations are rediscovered from the durable ticket state because GitHub no
longer lists them as open. Before a merge/close retires the active association,
the router drains every unread PR event from the current cursor, then moves that
cursor onto the retained row in the same durable write as the event batch. A
merge transition is forwarded as metadata only. `post_merge_poll_limit` bounds
how many retired PRs are read per poll in fair round-robin order by last poll
time; retained rows are not silently dropped, so an old PR is delayed rather
than abandoned. A read or verification failure keeps the cursor, backs that PR
off exponentially (active and retired alike), and does not fail the issue turn.
A newly adopted association starts at the current PR head instead of replaying
its prior history; a legacy row with a null cursor is seeded the same way.
Notifications contain event IDs, URLs, author/timestamp metadata and
per-category counts only. The routing adapter maps identity, author, timestamp
and URL into `TicketComment`; it does not request comment, review or issue
bodies. Review `state` is used only to skip pending drafts and is not forwarded;
review `path`/`line` are neither requested nor carried.

While a long agent turn runs, `tickets poll` keeps an intake ticker that
discovers newly opened trusted issues and records new events for other issues;
those are dispatched on the next poll. The ticker is independent of global
session slots, so a busy session does not stop intake for other issues. An
issue's session lease is exclusive: intake for the issue that is currently
running—or that still has an undelivered pending turn—defers instead of reading
concurrently, and collects on a later poll after that turn finishes. No event is
lost because the durable cursor and pending batch are only advanced by the
owning turn; the deferred intake retries from the same position. Its cadence is
`tickets.intake_poll_ms` (default 30 seconds), not a tight loop. Intake failures
are reported in the poll's `intake.errors` output and retried with exponential
backoff up to a five-minute cap. Intake claims use a separate short-lived claim
kind and never count against `tickets.max_concurrency`.

## Delivery windows and global cooldown

`tickets.delivery` can restrict automated ticket dispatches to weekly windows.
Without it (or with `windows: []`) the router runs 24/7; **no window is the
default**, so existing installations are unchanged. Windows require an explicit
IANA time zone (`UTC` is accepted); UTC offsets such as `+02:00` are rejected
because they ignore daylight saving.

```jsonc
"tickets": {
  "delivery": {
    "timezone": "UTC",
    "windows": [
      { "days": "weekdays", "start": "01:00", "end": "04:00" },
      { "days": "weekdays", "start": "06:00", "end": "10:00" }
    ],
    "cooldown_ms": 0
  }
}
```

`days` is `daily`, `weekdays`, `weekends` or a non-empty weekday array;
`start`/`end` are 24-hour `HH:MM` wall-clock times. The start is inclusive and
the end exclusive. An end at or before the start crosses midnight and opens on
the listed day. The example above is an operator-provided DeepSeek-style cost
heuristic, not a built-in policy, and it makes no price guarantee. Chinese public
holidays are out of scope; do not encode holidays here.

The delivery object is replaced as a whole at each precedence level
(`defaults.tickets` < top-level `tickets` < `repos.<project>.tickets`); omitted
fields fall back to the built-in default, not to a lower level. `cooldown_ms` is
a global start-to-start limit from `0` (disabled) through seven days. Every
bootstrap entry and follow-up dispatch claims it separately, including a turn
resumed at a persisted progress offset. A repository-level `delivery` object may
syntactically set `cooldown_ms`, but it is not a per-repository interval: every
project polled together and every poller sharing the runtime database must
resolve the same effective value, otherwise the poll fails closed with
`must be identical`.

Changing `cooldown_ms` requires the explicit transition
`tickets poll --delivery-reconfigure` while no ticket session or intake claim is
active. It updates the stored value and preserves the durable last-start anchor,
but the new interval applies to that anchor immediately: lowering can make the
next dispatch eligible at `last_started + new_cooldown` (possibly already in the
past), and raising delays it. The transition reports `last_started_at` and
`next_allowed_at`; to lower safely without abruptly unblocking a turn,
reconfigure after the old boundary has passed. `--delivery-cooldown-ms` is not a
one-off override: without `--delivery-reconfigure` a value that differs from the
stored durable value fails closed. Pollers still using the old value fail closed
until restarted. See
[`delivery-windows.md`](delivery-windows.md#changing-the-cooldown).

Outside an active window the router only records metadata: new trusted issues
and trusted issue/PR events are persisted with their identities and cursors,
without forwarding content, starting an agent turn or publishing status. The
per-issue `quiet_period_ms` keeps running independently. On the next opening the
accumulated batch is delivered to the same session in per-issue creation order;
a restart neither loses nor duplicates it. A running turn may finish when the
window closes; only new starts are gated. The window is rechecked and the global
cooldown is claimed in one atomic SQLite transaction immediately before every
bootstrap/follow-up dispatch, including resumed progress, so two pollers racing
after the same opening cannot both dispatch.

`goal` is an explicit single-ticket operator handoff and bypasses both delivery
windows and the global cooldown; it neither reads nor advances the durable
cooldown anchor. `tickets poll --delivery-24-7` ignores configured windows for
one invocation, but it does not bypass the cooldown: there is no one-off
cooldown override. Disable the cooldown durably with `cooldown_ms: 0` and
`--delivery-reconfigure`. An override is intentional manual action, not a
provider price or rate guarantee. See [`operator-cli.md`](operator-cli.md) and
[`delivery-windows.md`](delivery-windows.md).

Delivery is **at-least-once**, not exactly-once. The event batch, cursor and
deadline are committed before dispatch, but a crash after the agent starts and
before its result is persisted can replay that turn. Handoff and turn identities
support recovery; external agent side effects must still be idempotent.

`goal` accepts optional private operator acceptance criteria and routes them to
the same persistent ticket chat without copying issue/comment bodies. Both
`goal` and `tickets poll` require `agent_runner: "opencode"`; `command_runner`
remains available to other workflows but cannot be given the ticket agent's
private `gh` login. Ticket-agent sessions run directly inside the existing
container and may delegate bounded work to a `build-worker` subagent that shares
the parent's worktree, container, network, and `gh`/Git credential authority.
`question` is denied for the parent and the delegated worker; the agent
asks/resumes via trusted GitHub comments. The legacy `run --once` builder
remains OCI-isolated.

The legacy `run --once` path still uses `auto_merge` for its CLI-owned merge
flow. Ticket agents themselves read GitHub context and own repository changes,
commits, pushes, PRs, comments, and follow-up issues. The router only filters,
persists, and forwards event identities/URLs; it does not verify CI, merge, or
write status comments. Manual merge restrictions must be enforced through
provider permissions/branch protection, never by relying on prompt text. In
manual mode the agent's credentials must not have merge authority, or the
GitHub ruleset must withhold it.
