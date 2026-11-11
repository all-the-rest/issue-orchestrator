# V1 ticket-agent boundary

**Decision:** Treat the V1 ticket path as a trusted GitHub-event router that
assigns each issue and its pull-request follow-ups to one persistent OpenCode
chat. Scope and acceptance are tracked in
[issues #61–#64](https://github.com/all-the-rest/issue-orchestrator/issues/61).

## Responsibilities

- The router selects routing metadata, filters authors, persists ticket-to-chat
  identity and provider cursors, deduplicates events, then forwards stable IDs
  and GitHub URLs. It does not include copied issue/comment bodies or write
  source, commit, push, create/update PRs, post status/question comments, or
  claim it observed CI or merge state.
- Only configured `trusted_authors` can start or resume a ticket chat. The
  authenticated bot and configured tool accounts are ignored. Missing trusted
  author configuration fails closed.
- The agent reads the issue, comments, PR and review context itself through the
  existing `gh` login. It owns repository edits, commits, pushes, PRs, comments,
  and linked follow-up issues when scope expands.
- Each ticket uses its own persistent detached Git worktree inside the runtime
  container so separate chats do not share a checkout; the agent creates and
  publishes its own branch.
- Ticket agents run directly in the existing `code-dev` container. This
  container is the isolation boundary; no nested OCI builder sandbox or Docker
  host socket is added. Only the ticket-agent role receives a private copy of
  the configured GitHub CLI auth, narrowed to the `github.com` host block, and a
  private Git credential helper.
- A ticket agent may delegate bounded implementation work to the dedicated
  `build-worker` subagent. It uses the ticket session's configured model and
  cannot launch further subagents. The worker is **not** a separate security
  sandbox: it runs in the same worktree and container and shares the parent's
  trusted shell, network, `gh`, and Git credential authority. Shell permission
  patterns and result-file edit rules are defense in depth, not isolation, and
  an instruction not to publish is not an enforced boundary. Delegate only work
  the parent could perform itself.
- The OpenCode `question` tool remains denied on the ticket agent and on every
  delegated subagent. If blocked on a decision, the agent posts one concrete
  question as a GitHub comment and stops. A trusted reply resumes the same
  persistent chat.
- The legacy `run --once` OCI-isolated builder and its gates remain unchanged.

## Events and conversation

`tickets poll` discovers open issues authored by configured trusted authors in
enabled repositories. Later trusted ticket comments and trusted conversation,
inline-review, and submitted-review activity on the PR reported by that ticket
agent resume the same chat. PR association comes from agent-reported structured
references or GitHub association data, never from ticket text alone. Event
payloads contain the repository, issue/PR/comment identities, event kind and
URLs; the agent fetches full context itself.

Configure `tickets.bootstrap` as the ordered list of turns. Its length is the
message count, and the same sequence is used for new and update turns in the
same session. The default first turn reads the issue, project guidance and
build-verify instructions, then reports a plan. The second implements, verifies,
and publishes the work through the agent's GitHub login. If scope expands, the
agent creates a linked follow-up issue and manages related-ticket state rather
than silently expanding scope.

Follow-up event bursts are coalesced per issue for `tickets.quiet_period_ms`
(default 60 seconds). The durable batch records each distinct event identity,
its cursor, and the deadline; a new event on the same issue extends the
deadline. A batch is delivered only after the deadline and while one of
`tickets.max_concurrency` global session slots is free. The cap value is
persisted and enforced in SQLite across overlapping pollers and survives
restarts; a poller with a conflicting cap fails closed. Distinct issues can run
in parallel, but a busy session never causes two runs of the same issue chat,
including GitHub project spelling aliases. Session ownership is a
heartbeat-renewed durable lease with owner-CAS writes, not PID identity alone,
so a look-alike PID in another container cannot steal it. Capacity pressure
defers the batch without dropping or truncating events.

Delivery is at-least-once: event identity, cursor and deadline are committed
before dispatch, but a crash after the agent starts and before its result is
persisted can replay that turn. Handoff/turn identities support recovery;
agent-side external effects must be idempotent.

PR association fails closed without failing an otherwise valid turn. Multiple
agent-reported PR references for one issue are not associated, and a transient
verification failure or a replacement PR while the previous association is
still open defers association until a later poll. Issue events still complete
their turn; the router never silently switches the polled PR conversation.

`goal --goal-file` remains a manual entry point to the same persistent ticket
chat. Its optional private operator acceptance criteria are separate from
GitHub event data; issue and comment bodies are still read by the agent.

## Security and recovery

The ticket-agent runner validates ownership and mode on the copied `gh` auth
configuration, keeps it in private per-session XDG storage, and sets a private
per-session Git credential helper. It never passes host `HOME` or mutates host
Git/GitHub configuration. Missing or unsafe auth fails closed. Session identity,
event cursors, bootstrap progress, and pending turns survive restart; concurrent
polls cannot dispatch the same ticket twice.
