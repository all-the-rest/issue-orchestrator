# Unattended-run threat model

## Security objective and boundaries

An unattended run may edit and commit only its isolated issue worktree. The
orchestrator CLI is the sole actor that pushes branches, writes tracker
comments/labels, creates change requests, and merges. Builder shell commands run
in a fresh network-disabled OCI container; failure to find/inspect the local
image or runtime stops the run. The container receives the worktree, Git
metadata needed for local commits, and a read-only pnpm store—not the host home,
runtime socket, SSH agent, tracker CLI, or credentials.

The OpenCode process itself is **not** in that OCI container or a dedicated OS
user. It runs as the orchestrator's OS user. Its environment has private
HOME/XDG paths and does not inherit tracker/Git/SSH/provider credential
environment variables or host OpenCode auth data. OpenCode role permissions
deny ungranted tools, `question`, and external directories; builder `shell` is
only an OCI wrapper. These application controls are not a kernel security
boundary: a compromised OpenCode binary, Node runtime, or host process can still
act with the orchestrator user's filesystem and process rights. Provisioning a
dedicated OS account/host is an operator responsibility, not an isolation
feature provided by this project. Do not run unattended jobs as a user that owns
valuable host secrets.

## Threats and controls

| Threat | Controls | Residual risk |
| --- | --- | --- |
| Trusted-author account or issue compromise | Trusted author is a routing gate, not proof of benign content. Issue, PR, repo, diff, and comments are untrusted data. Independent review and native server approval remain separate gates. | A compromised trusted account can induce malicious changes within the configured project scope. |
| Prompt injection in issue/PR/repository content | GitHub content is untrusted; `question` is denied; ticket-agent runs inside the existing Docker container, while the legacy builder shell runs in OCI. | A ticket-agent injection may exercise the configured bot's GitHub permissions, including through a delegated worker that shares the same shell, network, and credential authority. |
| Malicious dependency | Frozen lockfile install, scoped offline staging, lifecycle scripts disabled, no-network DoD container, production dependency audit in CI. | Vulnerable or malicious locked code can still affect the worktree/outputs; audit does not prove safety. |
| Model/provider compromise | Legacy builder receives no GitHub credentials; ticket-agent receives only the configured GitHub CLI login in private per-session storage. OpenCode provider auth is isolated per session. | Ticket-agent can read/write as the bot account; model/provider data may be exfiltrated over its authorized network. |
| Evidence exfiltration | Legacy builder container has `--network=none`; ticket-agent has network and `gh` by design. | OpenCode and GitHub communicate externally. Never send customer data/secrets without approval. |
| Credential leakage | Environment scrubbing, private agent HOME/XDG paths, private logs with token redaction, gitleaks CI. | Redaction is pattern-based and cannot identify every secret format or prevent encoding/transforming data. Do not treat logs as a secret-safe sink. |

## V1 ticket-to-agent boundary

The OCI controls above apply only to the retained legacy `run --once` builder.
The V1 `goal` and `tickets poll` paths are route-only, as tracked in
[issues #61–#64](https://github.com/all-the-rest/issue-orchestrator/issues/61).
They send event IDs/URLs, not copied ticket/comment bodies. One deliberate
exception is the optional per-repository activation gate: the provider reads
the issue title/body and comments privately to decide whether a configured
login was mentioned by a trusted author. Only a boolean leaves that function;
the text is not persisted in router state, forwarded in an event payload, or
included in diagnostics. GitHub content remains untrusted data, and an
activation read failure fails closed for that issue without blocking others;
comment reads are page-bounded and an incomplete scan is reported as deferred,
never as a negative decision. A shared, durable time-based request budget is
reserved before any activation read or mention search, so an exhausted budget
performs no provider call and cannot be turned into a request storm. Granted
reservations are charged to a durable cross-project rotation, so one saturated
project yields the next poll or intake tick to the least recently served
project. Concurrent
pollers merge state transactionally: a stale writer cannot clear a positive
latch, replace a newer revision, undo a completed scan or move a cursor
backwards. Only content-free
revisions, policy digests, booleans, failure counts, page numbers and token
counts are cached durably.
The ticket-agent OpenCode role runs directly in the existing `code-dev`
container without a nested OCI sandbox. It receives a private per-session copy of the configured
GitHub CLI authentication, narrowed to the `github.com` host block, and can use
network/`gh` to read tickets and publish agent-owned changes. A ticket agent may
delegate bounded implementation work to one `build-worker` subagent in the same
worktree and container. That worker inherits the question denial and cannot
launch further subagents, but it shares the parent's trusted shell, network,
`gh`, and Git credential authority; it is not a separate security sandbox.
Delegate only work the parent could perform itself. `question` is denied for the
parent and every delegated worker; human decisions use a GitHub comment and
trusted-reply routing.

The Docker container is the execution boundary for the ticket agent; this is
not a hostile-kernel or dedicated-OS-user boundary. A compromised OpenCode,
Node, or container process may exercise every permission granted to the bot
login. In particular, the configured bot account's repository/org grants are
the real authority boundary, not something a prompt can narrow. Keep the Docker
host socket out of the container, use protected branches and required checks,
and revoke the bot's access if a session is compromised.

The `code-dev` supervisor and the router run as the same container UID as an
interactive development session. That UID can read the actual `gh` and provider
credentials and can reach the container's dind endpoint; the orchestrator state
directory's `0700` mode does not isolate it from that UID. Code-dev isolation
protects the host and other containers, not the operator's shell from the
router. Scope provider credentials and dind access to what the bot may use.

Every condition that must prevent an agent-side merge must be enforced outside
prompt text: protected branches/rulesets, required CI checks that encode all
merge hard-denies, and no agent bypass actors. Manual mode must be enforced by
provider permissions or an equivalent rule that withholds merge authority, not
merely by asking the agent not to merge. The legacy `run --once` path still has
its distinct CLI-owned `auto_merge` and native-approval gates below.

## Effects, merge, and server controls

In the legacy `run --once` path the builder may modify and locally commit in its
job worktree but must not push, call tracker write APIs, create a PR, or merge;
those are CLI operations. In the V1 ticket path the agent itself has the GitHub
authority assigned to the configured bot account. The router only filters,
persists, and routes events; it cannot sandbox or narrow that authority.
Configure server-side branch protection/rulesets with required CI and trusted
human approval as needed; the agent and router cannot guarantee those rules are
enabled or prevent administrator overrides. Binary evidence and anything
containing customer data must be inspected by a human before publication.

## Residual risks, non-goals, and operating requirements

- Ticket-agent container isolation does not protect against host root, a
  compromised Docker daemon, or other processes with access to the container.
- The ticket agent can use the configured bot's `gh` permissions; scope those
  permissions to the repositories and actions it is intended to manage.
- Prompts, trusted-author lists, regex scanning, and model review do not prevent
  compromise.
- This project does not protect against host root, compromised container
  runtime/daemon, provider account takeover, server administrators, or
  vulnerabilities in OpenCode/Node/kernel.
- The legacy builder is networkless, but the ticket agent and OpenCode require
  network/provider communication.
  Provider-side retention/training policies are outside this project's control.
- Lockfiles and audit gates reduce supply-chain drift; they do not establish
  dependency provenance or eliminate vulnerabilities.
- Configure CLI credentials, required branch rules, protected CI workflows,
  and a disposable runner. Never mount a host container socket into either
  agent role.

## Incident response

Stop the runner and revoke/rotate potentially exposed provider or tracker
credentials. Preserve the private runtime database and logs for investigation,
but treat them as potentially sensitive despite redaction. Disable the affected
repository's automation and auto-merge; inspect branch/PR/evidence objects and
audit events; notify affected maintainers/users under the disclosure policy.
Report vulnerabilities privately using [`SECURITY.md`](../SECURITY.md); do not
put exploit details or credentials in a public issue.
