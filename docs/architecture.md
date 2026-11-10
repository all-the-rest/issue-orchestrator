# Architecture

## V1 ticket-to-agent path

The V1 entry point is `issue-orchestrator goal --project <owner/repo> --issue
<number> --goal-file <private-path|->`. The CLI accepts GitHub only, reads the
exact operator-supplied final acceptance criteria, and persists them with the
ticket handoff. The `Ticket` port normalizes issue fields, labels, and comments;
SQLite stores the exact goal, handoff/turn state, status idempotency keys, and
the selected runner session identity for recovery. Run it from a checkout whose
`origin` matches the configured target project; that working tree is passed to
the selected agent integration.

The configured issue label (default `agent:auto-implement`) alone selects
auto-implement mode. Without it the ticket remains human-directed: the CLI
publishes a `REVIEW` status and does not start an agent. Titles are never
rewritten. Orchestrator/tool-authored comments are excluded from agent input.
Human comments and meaningful issue-field/label changes are separate structured
follow-up data and resume the same agent conversation with a stable turn ID.
Ticket and final-AC data stay outside the stable system prompt and are treated
as untrusted data.

There is one task-facing `Ticket` provider and the existing replaceable
`AgentRunner`; V1 does not add source-code, CI-observer, or merge provider ports.
The selected project agent/CLI integration owns source changes, pull requests,
CI observation, and merge. The orchestrator reports status but must not claim
that it independently verified CI or authorized a merge. Provider permissions,
branch protections, and required checks enforce manual-merge restrictions; the
system prompt is not an authorization boundary.

GitHub is the only V1 ticket provider. GitLab, Jira, remote runners, optional
event/webhook triggers, npm publishing, and binary releases are out of scope.
Direct PR-review polling is also post-V1; feedback copied into the GitHub issue
thread can trigger a follow-up.

## Retained legacy path

`run --once` remains a separate, earlier broad workflow for compatibility. It
can still select/resume queue work, use a private worktree, run local DoD and
evidence gates, observe PR checks, and perform its configured merge flow. It is
not invoked by `/goal` and is not the V1 ticket-to-agent responsibility model.
See [`providers.md`](providers.md) for the distinctions between these paths.
