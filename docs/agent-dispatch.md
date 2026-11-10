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

## V1 ticket handoff

The V1 `/goal` command is a separate synchronous path: it reads one configured
GitHub issue and comments through the Ticket port, persists the exact goal and
turn state in `ticket_handoffs`, then calls the configured project's
`AgentRunner`. It does not enqueue a provider event, run the legacy role
pipeline, or observe CI/PR/merge state. A stable terminal queue-job anchor links
runner sessions and logs to the existing session store without holding worker
capacity. Recovery reuses the same handoff goal, runner session, turn ID, and
provider status idempotency keys.
Terminal status comments use validated, sanitized results and explicit next
actions. Optional structured PR/check references are restricted to the selected
GitHub repository and are labeled agent-provided, not independently verified by
the bridge.

## OpenCode configuration

Installed OpenCode is V2.2.6. Its V2 config documents `experimental.subagent_depth` as the maximum
nested-subagent depth (default `1`); it is explicitly experimental
([official docs](https://opencode.ai/docs/config/#subagent-depth)). No nested delegation is used, so
depth `3` is not required or written. There is no setup-time config edit or topology switch; user
JSON/JSONC and credentials remain untouched. Any future nested-delegation proposal must revisit
compatibility and safe config editing.

## Operator controls

Use the shared `ISSUE_ORCHESTRATOR_HOME`, global `max_concurrency` (default `1`), per-repository
concurrency caps and `resource_locks`. Use `goal --project owner/repo --issue 123
--goal-file <private-file>` for V1 ticket handoff, or `run --once` for the
separate legacy workflow. Use `jobs list/show`, `jobs retry/cancel` and `logs` to inspect or control work. See the
[operator CLI](operator-cli.md) and [README](../README.md).
