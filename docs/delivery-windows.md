# Delivery windows and metadata-only notifications

Status: implemented. The weekly schedule, metadata-only notifications, runtime
gating, CLI flags, the atomic global cooldown and the explicit cooldown
reconfiguration transition are wired into the ticket path. Tests cover the pure
rules plus fake-GitHub runtime, CLI and SQLite persistence.

Implemented modules:

- `src/core/delivery-window.ts` — weekly schedule validation, time-zone-aware
  evaluation, boundaries, overnight windows, retry hints and global cooldown.
- `src/core/event-metadata.ts` — metadata-only event categories, de-duplication,
  bounded references, compact notification payload and content rejection.
- `src/core/ticket-runtime.ts` — pre-dispatch window gate and metadata-only
  intake; the cooldown is claimed immediately before a turn starts.
- `src/core/persistence.ts` — durable `ticket_delivery_state` row and atomic
  `claimTicketDispatchStart`.
- `src/core/config.ts` / `src/core/commands.ts` — config validation, precedence,
  `tickets poll` flags, help defaults and poll output.
- Tests: `test/delivery-window.mjs`, `test/event-metadata.mjs`,
  `test/ticket-runtime.mjs`, `test/persistence.mjs`, `test/goal-cli.mjs`.

## Safe default

There is no built-in active window. An installation with no `tickets.delivery`
configuration runs 24/7, exactly as before. A missing window must never be
interpreted as "dispatch only at some built-in time".

## Configuration

Windows live under the existing ticket settings, so they follow the established
precedence:

```jsonc
{
  "tickets": {
    "delivery": {
      "timezone": "UTC",
      "windows": [
        { "days": "weekdays", "start": "01:00", "end": "04:00" },
        { "days": "weekdays", "start": "06:00", "end": "10:00" }
      ],
      "cooldown_ms": 0
    }
  },
  "repos": {
    "owner/repo": {
      "tickets": {
        // Optional per-repository override of the same object.
        "delivery": { "timezone": "Europe/Berlin", "windows": [] }
      }
    }
  }
}
```

Precedence, highest first:

1. `tickets poll` window flags for one invocation (`--delivery-timezone`,
   `--delivery-window`, `--delivery-24-7`).
2. `repos.<project>.tickets.delivery`.
3. top-level `tickets.delivery`.
4. `defaults.tickets.delivery`.
5. Built-in safe default: no windows, `cooldown_ms: 0` (24/7).

The selected `delivery` object is replaced as a whole; lower levels do not fill
in omitted fields. Omitted fields therefore take the built-in default (no
windows / cooldown 0), never a partially inherited schedule. Window flags are
process-local and never rewrite the durable cooldown. `cooldown_ms` is a durable
global value: a differing `--delivery-cooldown-ms` is not a one-off override and
fails closed unless it is combined with `--delivery-reconfigure` (or matches the
already stored value).

Fields:

- `timezone` — required when `windows` is non-empty. An explicit IANA zone such
  as `UTC`, `Europe/Berlin` or `America/New_York`. UTC offsets such as `+02:00`
  are rejected because they silently ignore daylight saving. A time zone without
  windows is allowed but has no effect.
- `windows` — array of at most 64 entries. Each entry has `days`, `start` and
  `end`. `days` is `daily`, `weekdays`, `weekends`, or a non-empty weekly array
  (`["mon", "thu"]`, full names accepted). `start`/`end` are 24-hour `HH:MM`
  wall-clock times. The start is inclusive, the end exclusive; if `end` is not
  after `start` the window crosses midnight and opens on the listed day. Adjacent
  and overlapping windows are allowed; duplicates, invalid days/times, unknown
  fields and an empty `days` fail validation.
- An empty `windows` array or no `delivery` object means 24/7.
- `cooldown_ms` — optional global start-to-start cooldown, integer from `0`
  through seven days. Default `0` (disabled). It gates the start of automated
  turns only; a running turn may finish. The value is global, not per issue: a
  repository-level `delivery` object may syntactically set `cooldown_ms`, but
  every project polled in one invocation—and every poller sharing the runtime
  database—must resolve the same effective value, otherwise the poll fails
  closed with `must be identical`. Use a repository-level object for windows
  only; changing the global cooldown is a durable transition (below).

Daylight-saving boundaries are computed as wall-clock instants in the selected
zone. A fall-back wall time that occurs twice opens at its first occurrence; a
spring-forward wall time that does not exist shifts forward to the first valid
instant (for example `02:30` resolves to `03:00`). Avoid scheduling a window
entirely inside a spring-forward gap; it collapses deterministically instead of
becoming ambiguous.

### Operator example (not a default)

The issue's DeepSeek-style example is an operator-provided cost heuristic, not a
built-in policy or price guarantee:

```jsonc
"delivery": {
  "timezone": "UTC",
  "windows": [
    { "days": "weekdays", "start": "01:00", "end": "04:00" },
    { "days": "weekdays", "start": "06:00", "end": "10:00" }
  ]
}
```

All other hours and weekends are outside the window. Chinese public holidays are
out of scope; do not encode holidays in this schedule.

## CLI flags

The `tickets poll` flags are listed with their defaults in `--help`:

```text
--quiet-period-ms <n>           per-issue coalescing (default: config; 60000)
--intake-poll-ms <n>            background intake cadence (default: config; 30000)
--max-concurrency <n>           global ticket session cap (default: config; 1)
--delivery-timezone <IANA>      explicit zone for windows (default: config; none = 24/7)
--delivery-window <spec>        days=HH:MM-HH:MM[;...] (default: config; none = 24/7)
--delivery-cooldown-ms <n>      global start-to-start cooldown (default: config; 0 = off)
--delivery-24-7                 ignore configured windows for this invocation
--delivery-reconfigure          adopt a changed cooldown while no ticket session is active
```

`--delivery-window` uses `;` between entries; days accept group names or a comma
list:

```text
--delivery-window "weekdays=01:00-04:00;weekdays=06:00-10:00"
--delivery-window "sat,sun=10:00-12:00"
```

`parseDeliveryWindowSpec` validates the flag with the same rules as config. Any
flag that changes the schedule requires an explicit `--delivery-timezone`
(source: config or flag); a window set without a zone fails instead of assuming
the host zone.

Window flags (`--delivery-timezone`, `--delivery-window`, `--delivery-24-7`)
replace the corresponding config value for that process only. `--delivery-24-7`
clears configured windows and has nothing to do with the cooldown.

`--delivery-cooldown-ms` is different: the cooldown is a durable global value.
Use it together with `--delivery-reconfigure` to adopt a changed value, or pass
the value already stored. A differing value without `--delivery-reconfigure`
fails closed on a live poll (`must be identical`); it is never a per-invocation
cooldown bypass. The only exception is the first live poll that creates the
durable row: the effective value at that point becomes the stored value, so
choose the initial configuration deliberately.

## Runtime behavior

1. Before every automated dispatch — each configured `tickets.bootstrap` entry,
   every follow-up turn, and a resumed turn that persists a progress offset —
   evaluate the resolved schedule with the current time and the durable last
   dispatch start. A turn cannot bypass the window or cooldown by resuming at a
   later progress entry.
2. Outside a window, collect only metadata: discover new trusted issues and read
   trusted issue/PR events into durable per-issue pending batches. No agent
   session, status turn or content forwarding starts, and no cooldown is
   consumed. The poll still takes the issue's exclusive handoff lease and, with
   the global session cap, can defer as `capacity` while another project holds
   the last slot; events and cursors are untouched, and the intake ticker
   retries from the same position.
3. On the next open window, deliver accumulated metadata to the same persistent
   session in per-issue chronological order. A restart must neither lose nor
   duplicate event identities; the batch, cursor and deadline are committed
   together before dispatch.
4. Per-issue `quiet_period_ms` remains independent and still coalesces bursts, so
   the quiet deadline and the delivery window both apply. Batching is cumulative
   across an inactive period and a quiet window.
5. A dispatch that has already started may finish at window close; only new
   dispatch starts are gated. Remaining bootstrap entries wait for the next
   opening instead of being forwarded outside it.
6. Intake keeps discovering newly opened trusted issues and collecting events
   for *other* issues while a long turn runs. An issue's session lease is
   exclusive: intake for the issue that is currently running—or that still has
   an undelivered pending turn—returns `busy`/leaves it to the owning turn
   instead of reading concurrently. Collection for that issue resumes on a later
   poll after the long turn finishes and the pending turn has been delivered.
   Nothing is lost: the durable cursor and pending batch are only advanced while
   the lease is held, so the skipped read is retried from the same position.
7. A deferred outcome reports `pendingEvents` as the number of distinct event
   identities in the durable per-issue batch for every reason, including busy
   and capacity. Events already embedded in a persisted pending turn are
   delivered from that turn and are not counted twice.

### Global cooldown

The cooldown is start-to-start: the next automated dispatch may start once
`last_start + cooldown_ms` has elapsed. It is global across repositories and
pollers. Enforcement is atomic in the runtime SQLite database, in the same
transaction that admits the dispatch (a compare-and-set on
`ticket_delivery_state.last_started_ms`). Two pollers racing after the same
window opening must not both start a turn.

Each configured `tickets.bootstrap` entry — for an initial turn as well as a
follow-up turn — is its own automated dispatch start, so it claims the cooldown
separately. With a nonzero
cooldown a multi-message bootstrap therefore pauses at the boundary and resumes
at its persisted progress on a later poll; it never skips the remaining
messages, and it never dispatches them outside the window.

The durable row stores the effective cooldown together with the anchor. A
poller whose effective cooldown differs from the stored value fails closed
before the dispatch with `must be identical`, rather than enforcing a private
limit.

A claimed cooldown is consumed even when the dispatch then throws. Dispatch
errors are ambiguous: the runner may already have started the agent before the
failure surfaced, and a provider status write may also have reached GitHub.
Refunding would let another turn start inside the operator's global interval for
an agent that may already have acted, so there is no refund path. A failed
launch therefore conservatively keeps the anchor; plan for the next start after
`last_start + cooldown_ms`.

#### Changing the cooldown

Changing `cooldown_ms` is a deliberate operator transition, not something a
running poll may silently adopt:

1. Stop every `tickets poll` process (and any other writer using the runtime
   database) and wait until no ticket session or intake claim is active.
2. Update the configuration, then run one poll with
   `tickets poll --delivery-reconfigure` (add
   `--delivery-cooldown-ms <n>` to select the new value for that invocation).
3. Restart every poller with the new effective cooldown.

The reconfiguration updates `cooldown_ms` and preserves `last_started_ms`, but
the **new** cooldown applies to that anchor immediately. Lowering the value
therefore does not preserve the old, longer interval: the next dispatch becomes
eligible at `last_started_ms + new_cooldown_ms`, which may already be in the
past and unblocks an otherwise still-cooling poller. Raising it delays the next
start to the new boundary. The reconfiguration output reports both
`last_started_at` and the resulting `next_allowed_at` so the effect is visible.

Safe reconfiguration:

- To lower a cooldown without abruptly unblocking a turn, reconfigure only after
  the old boundary (`last_started_ms + old_cooldown_ms`) has already passed, or
  accept that the next poll may dispatch immediately.
- To raise a cooldown, any moment without an active lease is safe; the preserved
  anchor is measured against the longer interval.
- The command refuses while any live ticket lease (session or intake) exists, so
  it cannot pull the value from under an in-flight turn. A poller still running
  with the old value fails closed on its next read or claim; stop and restart
  it, or rerun the transition once it is stopped. Reapplying the same value is
  idempotent.

A repository-level `delivery` object may carry `cooldown_ms`, but it does not
create a per-repository interval: all projects polled together and all pollers
sharing the database must resolve the same value or fail closed. Running turns
are not interrupted when the cooldown is reached.

### Operator override

- `goal` is an explicit operator handoff for one ticket. It bypasses both the
  delivery windows **and** the global cooldown: it neither reads nor advances
  the durable cooldown anchor, and it does not alter the stored schedule. This
  is the only path that intentionally ignores the cooldown.
- `tickets poll --delivery-24-7` ignores configured windows for that invocation.
  It does not touch the global cooldown; there is no one-off cooldown override.
  To disable the cooldown, adopt `cooldown_ms: 0` through the durable
  `--delivery-reconfigure` transition.
- An override is intentional manual action, not a guarantee of provider pricing
  or rate availability. Deployments should record why they use it.

## Metadata-only event notification

Dispatched notifications use the `issue-orchestrator.ticket-event.v1` envelope.
They include the first-discovery kind, per-event identities (author, timestamp,
URL, source and a proven category) and a compact aggregate digest. They never
include issue text, comment/review bodies, titles, diffs or file content.

```json
{
  "protocol": "issue-orchestrator.ticket-event.v1",
  "kind": "update",
  "project": "owner/repo",
  "issue": 67,
  "ticketUrl": "https://github.com/owner/repo/issues/67",
  "changedFields": [],
  "events": [
    {
      "id": "123",
      "author": "trusted-human",
      "createdAt": "2026-11-09T01:15:00Z",
      "url": "https://github.com/owner/repo/issues/67#issuecomment-123",
      "source": "ticket",
      "category": "issue-comment"
    }
  ],
  "digest": {
    "total": 1,
    "categories": [
      {
        "category": "issue-comment",
        "count": 1,
        "references": [
          { "id": "123", "url": "https://github.com/owner/repo/issues/67#issuecomment-123" }
        ]
      }
    ],
    "firstOccurredAt": "2026-11-09T01:15:00Z",
    "lastOccurredAt": "2026-11-09T01:15:00Z"
  },
  "note": "Metadata only: no issue, comment, review, diff or file content is included. Fetch details from GitHub yourself."
}
```

`digest` is produced by `aggregateEventMetadata`: references are bounded
(default 20 per category) while `count` always reflects the full batch.
Identities are de-duplicated by category plus provider event ID. Unclassified
events keep their raw provider `source` label.

### Initial discovery is not issue creation

The first route-only dispatch uses `kind: "initial"` with an empty `events`
array and an empty digest. That reliably identifies the first agent turn for
this durable ticket job—the router's initial discovery of the ticket—not a
GitHub creation event. Polling observes an issue after it already exists (and
may discover an old issue when it is selected or becomes eligible), so it cannot
prove that the issue was created at that moment or that no earlier activity
happened. `issue-created` is therefore **never emitted** by the current path.
It is reserved for a future provider that records an explicit `opened` event;
`issueCreatedMetadata` only accepts such proven creation input. Do not infer
creation from `kind: "initial"` or from a closed-window ticket identity.

Categories and what proves them:

| Category | Emitted when | Certainty notes |
| --- | --- | --- |
| `issue-created` | a provider records an explicit issue-creation event | **not emitted by the current GitHub polling path**: initial discovery is `kind: "initial"` with no events, and closed-window discovery only persists the ticket identity. `issueCreatedMetadata` is reserved for a future provider that proves creation. |
| `issue-edited` | the provider proves the editor and that editor is trusted | **not emitted by the current GitHub path**: a title/body snapshot difference does not prove who edited, so `issueEditedMetadata` returns `null` |
| `issue-comment` | a trusted issue comment is read | distinct from PR conversation comments |
| `pr-conversation` | a trusted comment in the associated PR conversation | provider ID prefix `issue-comment:` |
| `pr-review` | a submitted review on the associated PR | provider ID prefix `review:`; pending reviews are already filtered out |
| `pr-review-comment` | an inline/review comment on the associated PR | provider ID prefix `review-comment:` |
| `pr-merge` | verified associated PR state transitions to `MERGED` | only after `verifyChange` succeeds |
| `pr-closed` | verified associated PR state transitions to `CLOSED` | only after `verifyChange` succeeds |
| `pr-state-changed` | another verified transition, e.g. reopened | never inferred from ticket text |
| `unclassified` | a `change` update whose collection is unknown | raw `source` retained; category is not guessed |

An ordinary PR conversation comment is never classified as an issue text change.
If the API cannot establish a category, the event is `unclassified`, not a
made-up category. The router performs no provider writes for any of these paths.

Persistence stores the same metadata-only ticket updates (provider identity,
author, timestamp, URL, source and any proven category) so a restart can rebuild
the digest; bodies are never kept. The GitHub routing adapter maps only identity,
author, timestamp and URL into `TicketComment`. It requests no comment, review,
issue or diff bodies. Review `state` is read only to exclude pending drafts and
is not forwarded; review `path` and `line` are neither requested nor carried
because `TicketComment` has no such fields. The ticket agent reads the content
itself through its own `gh` login.

## Implementation map

- `src/core/config.ts`: `tickets.delivery` is validated with
  `normalizeDeliverySchedule` and resolved as a whole object with the precedence
  above into `RepoRuntimeConfig.tickets.delivery`.
- `src/core/commands.ts`: the four flags are parsed, the per-invocation schedule
  is validated, a `delivery` diagnostics block is included in poll JSON, and
  `HELP` lists the flags and safe defaults. `goal` intentionally passes no
  schedule and therefore remains an explicit operator override.
- `src/core/ticket-runtime.ts`: a pre-dispatch gate persists metadata-only events
  and returns a deferred outcome without starting a session or status turn. The
  `admitDispatch` helper rechecks the window and atomically claims the cooldown
  immediately before **every** bootstrap entry and follow-up dispatch, including
  resumed progress. A dispatch failure conservatively keeps the claimed interval;
  there is no refund path.
- `src/core/persistence.ts`: `ticket_delivery_state` stores the global cooldown
  and last start; `claimTicketDispatchStart` performs the compare-and-set in one
  SQLite transaction, rejects a conflicting poller configuration and consumes the
  claim on every successful admission; and `reconfigureTicketDelivery` implements
  the explicit, lease-gated cooldown transition. It preserves the last-start
  anchor, applies the new interval immediately, and reports the resulting
  `nextAllowedAt` boundary.
- `src/core/commands.ts`: `tickets poll --delivery-reconfigure` performs the
  transition before the delivery report, reports `last_started_at` and
  `next_allowed_at`, and rejects `--dry-run`.
- `test/delivery-window.mjs` covers validation, UTC/weekday/weekend boundaries,
  overnight windows, DST gaps/folds, retry hints and cooldown arithmetic.
- `test/event-metadata.mjs` covers category certainty, content rejection and
  aggregation.
- `test/ticket-runtime.mjs` covers closed-window discovery, metadata-only
  batching, restart, quiet=0 intake, quiet=0 with a closed window, 24/7 with a
  nonzero cooldown, per-dispatch gating and resumed bootstrap/follow-up
  progress, start-then-throw cooldown retention, and post-merge
  conversation/review/inline review delivery.
- `test/persistence.mjs` covers durable, transactional cooldown claims across
  two pollers, restart, config mismatch, conservative failure handling, and the
  explicit reconfiguration transition including the immediately effective new
  boundary.
- `test/goal-cli.mjs` covers `--help` defaults, flag precedence/validation,
  closed-window polling, the no-dispatch/no-write behavior with fake `gh`, and
  the explicit cooldown transition including stale-poller fail-closed.

No provider writes occur while a window is closed: the poll runs metadata-only
intake, and the ticket routing port publishes only in-memory status markers.

