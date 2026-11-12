# Operator CLI surface

`setup --print` prints a static setup checklist for the router: building the
CLI, preparing the bot's `gh` login, configuring the model/account/trusted
authors/DoD, the built-in ticket-agent and `build-worker` topology with the
`question` tool denied, and remote Docker deployment with systemd autostart.
It is intended for an agent to read and follow. It reads no config, opens no
SQLite database, runs no provider command, writes no file, and prints no
credential values; any other argument or action is refused. The guidance is
compiled into `dist`, so it is available without repository docs, and it
references shipped documents by relative path.

`doctor --json` emits `{ "schema_version": 1, "checks": [...] }`; checks have
`name`, `status` (`ok`, `failed`, or `missing`), and sanitized `message`.
`status --json` contains config, database path, zero-filled queue counts, active
leases, `next_run: null`, last run, and reconciliation status. `jobs list --json`
returns up to 100 sanitized job objects; `jobs show <id> --json` returns one.
Neither includes ownership tokens, process identity, or credentials.

`jobs cancel <id>` atomically cancels only a `READY` queued job; active and
terminal jobs are refused. `jobs retry <id>` creates a new `READY` row and
retains the failed row/history. It is permitted only for a `FAILED` job below
`max_attempts`, without branch/change/head/evidence identifiers, artifacts, or
side-effect journal entries, and while no job is active. It does not skip the
normal claim and merge gates. Mutations take the queue mutation guard but do not
reconcile providers.

`logs [--job <id>] [--follow] [--json]` maps persisted sessions to the private
`${dirname(databasePath())}/agent-sessions/<session-id>/` directory. Only fixed
`events.ndjson` and `stderr.log` files are read; symlinks and non-regular files
are rejected, each initial read is limited to the last 64 KiB, and follow chunks
are limited to 16 KiB. Missing logs produce no entry. JSON snapshot shape is
`{ "schema_version": 1, "logs": [{ "session_id", "kind", "content" }] }`.
With `--follow --json`, the initial snapshot is followed by JSON Lines append
events `{ "schema_version": 1, "event": "append", "session_id", "kind", "content" }`;
Ctrl-C ends the stream. Logs never expose agent process credentials.

`goal --project <owner/repo> --issue <number> --goal-file <private-path|-> [--retry-blocked]`
accepts optional operator-provided acceptance criteria from an owned, private
regular file or stdin, bounded to 32 KiB. It routes the criteria separately from
GitHub event data; ticket and comment bodies are never fetched or copied into
the router payload. It shares the ticket's persistent OpenCode chat and uses the same
configured bootstrap as `tickets poll`. Run it from a checkout whose `origin`
matches the project. Ticket agents require `agent_runner: "opencode"`; the
runner executes directly in the existing container, has private access to the
configured `gh` login, and owns repository edits, commits, pushes, PRs, comments,
and follow-up issues. The router writes no status or question comments. The
interactive `question` tool is denied; the agent asks a concrete question in a
GitHub comment and stops, then a trusted reply resumes this chat.

`--retry-blocked` explicitly continues the persisted agent conversation after
local remediation; it does not write a human comment. The legacy `run --once`
OCI-isolated builder workflow is unchanged.

`tickets poll [--project <owner/repo>] [--dry-run] [--max <n>] [--retry-blocked]`
`[--quiet-period-ms <n>] [--intake-poll-ms <n>] [--max-concurrency <n>]`
`[--delivery-timezone <IANA>] [--delivery-window <spec>] [--delivery-cooldown-ms <n>] [--delivery-24-7]`
dispatches open issues authored by a configured trusted author in enabled
repositories, up to `--max` newly listed candidates per project (default 1000).
Persisted route-only handoffs with active or retained PR associations are
always rediscovered from SQLite, including closed issues, so post-merge activity
is not lost when GitHub stops listing the issue as open. A retained record is
rediscovered only when it has an active or retired PR association and the
provider still reports a trusted (non-excluded) author; a closed issue must have
already started its persistent chat. If the issue identity cannot be read, the
record is skipped safely for that poll instead of starting an agent. Distinct
issues run concurrently up to the global `tickets.max_concurrency` cap. Each
ticket gets a
detached Git worktree under the runtime home for its persistent chat; this is
not a nested OCI sandbox. `repos.<project>.workspace` selects the base checkout;
without it the current directory must be a checkout of the project.
`--dry-run` lists trusted candidates without starting an agent or writing
SQLite/GitHub state. Actual routing requires `agent_runner: "opencode"` and a
non-empty `trusted_authors` allowlist.

Scheduling defaults are visible in `--help`: quiet period `60000` ms, intake
cadence `30000` ms, ticket concurrency `1`, no delivery window (24/7) and a
global cooldown of `0` (disabled). `--quiet-period-ms`,
`--intake-poll-ms` and `--max-concurrency` override the corresponding
`tickets` settings for one invocation. `--delivery-window` takes
`days=HH:MM-HH:MM` entries separated by `;`, for example
`"weekdays=01:00-04:00;weekdays=06:00-10:00"`; days also accept `daily`,
`weekdays`, `weekends` or a comma list. `--delivery-timezone` requires an
explicit IANA zone such as `UTC`. The window flags override the corresponding
`tickets.delivery` values for that invocation only. `--delivery-24-7` ignores
configured windows for the run; it does not bypass the cooldown. There is no
one-off cooldown override: `--delivery-cooldown-ms` selects the value for a
durable `--delivery-reconfigure` transition, and a differing value without it
fails closed on a live poll. `goal` is an explicit operator handoff and bypasses
both delivery windows and the global cooldown; it neither reads nor advances the
stored cooldown anchor. An override is manual action, not a provider price or
rate guarantee.

A changed global cooldown must be adopted explicitly with
`tickets poll --delivery-reconfigure` while no ticket session or intake claim is
active (stop every poller first). The transition preserves the durable
last-start anchor, but the new interval applies to it immediately: lowering can
make the next start eligible at `last_start + new_cooldown`, while raising
delays it. The output reports `last_started_at` and `next_allowed_at`; to lower
without abruptly unblocking a turn, reconfigure after the old boundary has
passed. The transition refuses while a live lease exists, and a still-running
poller with the old value fails closed until restarted.
`--delivery-reconfigure` cannot be combined with `--dry-run`.

Outside a window, trusted issue/PR events are collected as metadata only and
delivered in order at the next opening; no new agent turn starts and no status
is written. `quiet_period_ms=0` still runs the intake ticker, so a closed window
cannot lose events. Intake for the issue whose turn is currently running (or
whose pending turn is still undelivered) waits for that exclusive lease and
retries later from the same durable cursor; other issues and new-issue
discovery continue. The poll output includes a `delivery` block with the
effective schedule, active state, and the next change/retry timestamp.

Follow-up events on one issue are held for `tickets.quiet_period_ms` (default
60000; `0` disables) so a burst becomes one agent turn. The first batch is
persisted with its event IDs, cursor, and deadline before dispatch; it survives
restarts and is not truncated. A batch is delivered only after the deadline and
when a global slot is free. A full cap defers the issue without losing events.
Because delivery is poll-driven, the worker interval adds latency; keep it at or
below the quiet period. A busy issue session returns a deferred outcome (not a
failure) and is retried later. Intake during a long turn runs at
`tickets.intake_poll_ms` (default 30 seconds, never a tight loop); its errors
appear under `intake.errors` and back off exponentially. Delivery is
at-least-once: a crash after dispatch
but before result persistence can replay the same turn, so agent-side effects
must be idempotent.

Each new and update turn dispatches the configured ordered `tickets.bootstrap`
messages as separate turns in the same agent session. The router forwards event
IDs and URLs only; the agent fetches issue, comment, and PR context itself.
When blocked on a decision, the agent posts one concrete question, ends the
turn, and waits for a trusted-author reply.

Trusted-author comments on the ticket and on the agent-reported same-repository
pull request (conversation, inline review activity, and submitted reviews)
resume the same agent session. The router reads metadata identities only, not
comment or review bodies. Comments by the authenticated bot/configured tool
accounts and all non-trusted authors are ignored. The router neither creates
nor adopts a PR from ticket text; the agent reads the live PR context.

The `issue-orchestrator goal` CLI command is this path. The project ships no
OpenCode `/goal` slash-command override, so OpenCode's built-in `/goal` command
is unaffected. The CLI reports the selected agent's structured result; it does
not claim that it observed green CI or authorized a merge.

`project add <id> --from <existing>` clones a validated project definition;
`project remove <id>` refuses to remove the last project; `pause` and `resume`
set the project's `enabled` flag. Updates preserve unrelated config text and
comments, validate a same-directory temporary file, preserve mode, then atomically
replace the original. Project commands use the global mutation guard, so
orchestrator CLI writers are serialized; an inode/content check also rejects
changes observed before replacement. The CLI cannot coordinate with arbitrary
external editors, so do not edit the same config concurrently. Unsafe or
unlocatable edits fail without changing the file.

Exit statuses are 0 for success, 1 for refused/failed commands, 2 for invalid
configuration, and 8 for pending checks. `doctor` performs local probes only;
it never switches provider accounts or contacts model APIs.
