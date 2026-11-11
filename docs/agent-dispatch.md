# Agent dispatch topology

## Retained legacy dispatcher

The `run --once` compatibility workflow uses one deterministic dispatcher over
shared SQLite, with direct project-scoped role sessions per job.
There is no global LLM supervisor or per-project LLM orchestrator; this product-wide choice is fixed.
Software owns queue, deduplication, capacity and recovery; agents run triage, builder, verifier and reviewer roles.

The shared SQLite `events` ledger is the single durable deduplication source. One transaction records
an event, upserts its work item and enqueues its READY job. Provider delivery IDs are unique per
provider; without one, the key is work-item/kind/payload. Redelivery returns the existing event/job,
which the dispatcher claims transactionally; role sessions persist against that same job.

Provider webhook ingress is not shipped: `run --once` polls configured trackers. Future ingress
adapters must use this shared ledger and never dispatch agents directly. Global concurrency defaults
to `1`, with per-project/resource caps for workers sharing the runtime home. Optional signed-webhook
and GitHub Actions triggers remain [issue #16](https://github.com/all-the-rest/issue-orchestrator/issues/16).

## V1 ticket routing

`goal` and `tickets poll` share the same route-only runtime. It selects GitHub
routing metadata, filters trusted authors, persists issue-to-chat identity and
event cursors in `ticket_handoffs`, and sends only event IDs/URLs to a
`ticket-agent` OpenCode session. The agent reads ticket and PR context with
`gh`, and owns repository edits and GitHub writes. The routing port suppresses
status comments, but the router does poll the associated PR conversation and
state so merge/close transitions and later trusted activity reach the same
session. A stable runner-job anchor links
the persistent session and logs to the existing session store without holding
worker capacity. Recovery reuses the same runner session, turn ID, cursor, and
bootstrap progress.

The ticket-agent role runs in the existing container without the nested OCI
builder sandbox. It receives private per-session GitHub CLI authentication;
`question` remains denied. PR events route to the existing ticket session only
when associated through agent-reported structured references or GitHub data.
The retained `run --once` dispatcher and builder isolation are unchanged.

## OpenCode configuration

Installed OpenCode is V2.2.6. Its V2 config documents `experimental.subagent_depth` as the maximum
nested-subagent depth (default `1`); it is explicitly experimental
([official docs](https://opencode.ai/docs/config/#subagent-depth)). The ticket-agent role may launch
only the dedicated `build-worker` subagent and pins `subagent_depth` to `1`; the worker cannot launch
further subagents. Both profiles deny `question`. The worker uses the ticket session's configured model,
including an optional `#variant` such as `openai/gpt-6-luna#xhigh`.

The delegated worker is **not** a security sandbox. It runs in the same worktree and container as the
parent and shares the parent's trusted shell, network, `gh`, and Git credential authority. OpenCode
shell permission patterns and an `edit` rule for the result file are defense in depth, not isolation:
shell commands can bypass glob-based restrictions and can write the same files or use the same
credentials. Delegate only work the parent could perform itself. Stronger delegation isolation would
require a separate container or credential boundary and is not claimed. Other roles cannot launch
subagents, and the legacy builder keeps its OCI sandbox. There is no setup-time config edit or topology
switch; user JSON/JSONC and credentials remain untouched.

## Operator controls

Use the shared `ISSUE_ORCHESTRATOR_HOME`. For V1 ticket routing the global
session cap is `tickets.max_concurrency` (default `1`) and event bursts are
coalesced for `tickets.quiet_period_ms` (default `60000`). The retained legacy
builder uses `max_concurrency`, per-repository caps and `resource_locks`. Use
`goal --project owner/repo --issue 123 --goal-file <private-file>` for V1 ticket
handoff, or `run --once` for the separate legacy workflow. Use `jobs list/show`, `jobs retry/cancel` and `logs` to inspect or control work. See the
[operator CLI](operator-cli.md) and [README](../README.md).
