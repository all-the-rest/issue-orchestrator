# V1 ticket-to-agent boundary

**Decision:** Keep the V1 tool focused on structured GitHub ticket intake and
agent handoff. This decision is tracked by
[issue #53](https://github.com/all-the-rest/issue-orchestrator/issues/53).

## Responsibilities

- The provider-facing V1 port reads/selects GitHub issues and their comments or
  updates. The existing AgentRunner boundary starts the configured agent.
- Project configuration selects the agent/CLI integration. This tool does not
  add separate CI-observer or source-code provider ports for V1.
- The selected agent/project integration owns repository edits, PR lifecycle, CI
  observation, and merge. The bridge must not claim it checked CI or authorized
  a merge.
- GitHub is the only V1 tracker. Jira, GitLab, remote runners, and optional event
  ingress are outside this release.

## Conversation and ticket updates

Start each agent conversation with a minimal, stable system prompt explaining
the agent's role, the structured ticket/goal input, how later ticket updates are
delivered, and the structured-result contract. Keep workflow prose out of that
prompt. Issue bodies, comments, updates, and final acceptance criteria are
separate structured, untrusted data, never executable authority.

Auto-implement mode is indicated by a configured GitHub issue label, not a title
prefix. Initial and terminal status comments identify the selected mode. Ignore
comments authored by the orchestrator/agent when building later agent inputs so
the tool cannot trigger itself in a loop. New human issue comments are delivered
as structured follow-up messages. V1 does not poll PR review comments directly;
review feedback copied into the ticket thread can trigger a follow-up turn.

`/goal` supplies the final acceptance criteria for the ticket. Persist the exact
goal with the job and reuse it across retries/recovery rather than silently
substituting newer issue text.

## Merge and security boundary

Autonomous merge is the default agent/project policy after required CI passes;
manual merge remains an explicit opt-out. The project/provider integration is
the enforcement boundary: protected branches and required status checks must
encode every merge hard-deny and provide no agent bypass. Manual mode must be
enforced by provider permissions or an equivalent control, not prompt wording
alone. The bridge still gates trusted ticket dispatch, treats all ticket content
as untrusted, and never puts credentials in agent payloads.

## Runtime distinction

`goal` is the V1 entry point and follows the bridge boundary above. The older
`run --once` workflow remains separate for compatibility; it retains its
CLI-owned source, CI, evidence, and merge gates and is not called by `/goal`.
