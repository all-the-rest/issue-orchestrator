# Architecture

## V1 ticket-to-agent path

`tickets poll` watches enabled GitHub repositories for issues authored by
configured trusted authors. A repository may set `tickets.activation_mention`
so the first ticket-agent turn starts only after that login is explicitly
mentioned by a trusted author in the issue title/body or a comment. The provider
privately reads those fields solely to compute an activation boolean; the text
is not persisted, forwarded, or logged. An explicit operator `goal` command is
already affirmative and bypasses this poller gate. The route-only `goal`
command can also start or continue the same issue chat and add optional private
operator acceptance criteria. Apart from that activation check, the Ticket
provider fetches routing metadata and event cursors only; the router forwards
stable issue/comment/PR IDs and URLs, never copied ticket/comment bodies.
SQLite persists ticket-to-chat identity, event cursors,
coalesced event batches and their quiet-period deadlines, bootstrap progress,
and runner-session recovery data. A database-wide admission transaction caps
simultaneously active issue sessions (`tickets.max_concurrency`) across
pollers; distinct issues may run in parallel, while the per-issue worktree lock
still prevents two workflows—or GitHub project spelling aliases—from running the
same chat. The cap is persisted, and a conflicting poller fails closed. Session
ownership uses a heartbeat-renewed durable lease with owner-CAS state writes, so
PID reuse or a look-alike PID in another container cannot steal a live session.
A crash after dispatch can replay the turn, so delivery is at-least-once.
When the open-issue listing window is saturated, activation discovery also uses
one bounded GitHub mention search; it is advisory, independently capped, and
subject to provider search indexing limits. Every activation pass is hard-bounded
(20 checks per repository, 4 comment pages per check). Content-free durable state
stores the revision, policy digest, boolean result, failure count, descending
page cursor and the newest page seen. A revision change re-reads the newest page
and continues the saved cursor unless the thread gained a page, so ordinary
comments do not reset history; a page cap is reported as deferred instead of
becoming a silent negative. State writes merge against the committed row inside
one transaction: positives latch, a stale revision cannot overwrite a newer one,
and same-revision progress cannot move backwards. One durable, time-based budget
(45 requests per minute, persisted across restarts) is shared by every poller
process and project for activation reads. The optional mention search uses a
separate durable rolling-window budget of 30 requests per minute, matching
GitHub's search limit: a grant is admitted only while the summed cost of all
grants in the preceding minute stays within 30, so a burst plus refill or extra
projects cannot exceed the quota. Each scan or search reserves its worst-case
request count before any provider call, so an exhausted budget defers work with
a retry time and makes no request. Granted reservations also advance a durable
per-project rotation, so the least recently served project goes first in the
next poll or intake tick and a saturated project cannot starve the others.
Candidates beyond either budget rotate fairly on later polls.

Only trusted-author activity can start or resume a ticket chat; the authenticated
bot and configured tool accounts are ignored. Issue comments and conversation,
inline-review, and submitted-review activity on an agent-associated PR resume
the same OpenCode session. The agent reads all ticket and PR content through
`gh` itself. It owns source changes, commits, pushes, PRs, comments, and linked
follow-up tickets. The router posts no status/question comments and does not
claim it observed CI or authorized a merge.

Ticket agents run directly in the existing container without a nested OCI
sandbox. The OpenCode `question` tool is denied; the agent asks in a GitHub
comment and stops, and a trusted reply resumes the same chat. Configure ordered
`tickets.bootstrap` messages; the same configured sequence is used for new and
update turns. Provider permissions, branch protections, and required checks—not
prompt text—enforce merge restrictions.

GitHub is the only V1 ticket provider. GitLab, Jira, remote event/webhook
ingress, npm publishing, and binary releases are out of scope.

## Retained legacy path

`run --once` remains a separate, earlier broad workflow for compatibility. It
can still select/resume queue work, use a private worktree, run local DoD and
evidence gates, observe PR checks, and perform its configured merge flow. It is
not invoked by the `goal` command and is not the V1 ticket-to-agent
responsibility model.
See [`providers.md`](providers.md) for the distinctions between these paths.
