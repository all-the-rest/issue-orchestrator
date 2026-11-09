# Architecture

## Current implementation

The current `main` implementation is the earlier broad Tracker/CodeHost
workflow; it has **not** yet migrated to the adopted design in
[issue #53](https://github.com/all-the-rest/issue-orchestrator/issues/53).
The CLI/core owns queueing, persistence and recovery, workflow gates, evidence,
and merge decisions. It selects separate `Tracker` and `CodeHost` provider
ports, plus an `AgentRunner`. GitHub and the OpenCode runner are the working
vertical slice; GitLab and Jira adapters are fail-closed stubs. See
[`providers.md`](providers.md) for the current adapter matrix and behavior.

The `run --once` path selects or resumes work, runs agent roles in a private
worktree, executes configured local DoD commands, publishes evidence, and
performs review and the configured merge gates. In this implementation the CLI
observes required checks and may merge after its gates pass. This is a
description of existing behavior, not the target responsibility split.

## Adopted target (pending migration)

Issue #53 adopts a narrower GitHub ticket/update-to-agent bridge: one
ticket-facing provider port and the existing `AgentRunner` boundary. V1 does
not add separate CI-observer or source-code provider ports. A project's chosen
agent/CLI integration owns source edits, pull-request lifecycle, CI observation,
and merge. The orchestrator must not claim that it verified CI or authorize a
merge. GitHub is the only V1 provider; GitLab, Jira, remote runners, optional
webhook/event triggers, and npm publishing/binaries are out of scope.

In the target flow, an issue label alone selects auto-implement mode; there is
no title prefix. Initial and status comments identify the mode. Orchestrator- or
agent-authored comments are not new inputs. Human issue comments are structured
follow-up messages. Direct PR-review polling is post-V1; feedback copied into
the ticket thread can trigger a follow-up. `/goal` carries persisted final
acceptance criteria as structured untrusted data, while the system prompt stays
minimal.

Autonomous merge after required CI is the default policy passed to the selected
agent integration; manual merge is an opt-out. Provider/project branch
protections and required checks, with no agent bypass, enforce hard denies.
Manual mode must be enforced by provider permissions, not prompt text. These
are target decisions, not capabilities or configuration currently implemented
by this repository. In particular, current `auto_merge` and CLI-owned gates
described above must not be mistaken for this target policy.
