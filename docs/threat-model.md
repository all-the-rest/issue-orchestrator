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
| Prompt injection in issue/PR/repository content | Role-specific OpenCode config denies by default; questions and web access are not granted; builder shell runs in OCI; review receives complete diff as untrusted data. | Model policy/permission bugs and malicious outputs remain possible. |
| Malicious dependency | Frozen lockfile install, scoped offline staging, lifecycle scripts disabled, no-network DoD container, production dependency audit in CI. | Vulnerable or malicious locked code can still affect the worktree/outputs; audit does not prove safety. |
| Model/provider compromise | No tracker/Git credentials in agent environment; no `gh`/`glab` on agent PATH; CLI alone owns provider writes. Only OpenCode's provider `auth.json` is copied to private session data, and the host data path is not exposed. | The model process can use/exfiltrate its configured model-provider credentials; OpenCode runs under the host account and may access resources exposed by the OS/runtime beyond the explicit environment. Provider credentials used by the host CLI remain high-value. |
| Evidence exfiltration | Builder container has `--network=none`; no host provider CLI or credential mounts; evidence is validated and published by the CLI. | OpenCode control plane may communicate with its configured model provider. Never send customer data/secrets without approval. |
| Credential leakage | Environment scrubbing, private agent HOME/XDG paths, private logs with token redaction, gitleaks CI. | Redaction is pattern-based and cannot identify every secret format or prevent encoding/transforming data. Do not treat logs as a secret-safe sink. |

## Adopted V1 bridge boundary (migration pending)

The controls above describe the current full-workflow implementation. The
adopted V1 target in [issue #53](https://github.com/all-the-rest/issue-orchestrator/issues/53)
is narrower: the bridge reads structured GitHub issues/comments and sends them
to a project-selected agent integration. It does not inspect CI, edit source,
manage PRs, or call merge APIs. The selected agent/project integration owns
those operations and their provider CLI.

Ticket bodies, comments, updates, and final acceptance criteria remain untrusted
data and are never executable authority. The bridge does not put credentials in
those payloads. However, an agent integration that can use a project CLI may be
able to access that CLI's credential store; this is a real authority boundary,
not something a short prompt or the ticket bridge can sandbox. Run it under a
disposable/dedicated OS identity and give it only the minimum project-scoped,
short-lived permissions required.

Every condition that must prevent an agent-side merge must be enforced outside
prompt text: protected branches/rulesets, required CI checks that encode all
merge hard-denies, and no agent bypass actors. Do not grant administrators or
the agent a bypass path for those checks. The default permits agent merge only
after provider-required checks pass; manual mode must be enforced by provider
permissions or an equivalent rule that withholds merge authority, not merely by
asking the agent not to merge. This differs from the current CLI-owned
`auto_merge` and native-approval gates documented below. These target controls
are not implemented by the current runtime yet.

## Effects, merge, and server controls

The builder may modify and locally commit in its job worktree. It must not push,
call tracker write APIs, label, comment, create a PR, or merge. Those are CLI
operations. Auto-merge defaults to true for enabled projects; `auto_merge: false`
is the explicit opt-out. This default is not a safety boundary: configure
server-side branch protection/rulesets with required CI and trusted
human approval. The CLI checks observed approvals/checks but cannot enforce or
replace server-side protection, prevent administrator overrides, or guarantee
branch protection is enabled, and the CLI does not assume that it is. Binary evidence and
anything containing customer data must be inspected by a human before
publication.

## Residual risks, non-goals, and operating requirements

- This is not a dedicated-user or hostile-kernel sandbox for OpenCode. Full
  host-process isolation is not implemented; unattended use must be gated to a
  disposable/dedicated host or externally managed container until it exists.
- Prompts, trusted-author lists, regex scanning, and model review do not prevent
  compromise.
- This project does not protect against host root, compromised container
  runtime/daemon, provider account takeover, server administrators, or
  vulnerabilities in OpenCode/Node/kernel.
- Builder is networkless, but OpenCode requires provider communication.
  Provider-side retention/training policies are outside this project's control.
- Lockfiles and audit gates reduce supply-chain drift; they do not establish
  dependency provenance or eliminate vulnerabilities.
- Configure least-privilege CLI credentials, required branch rules, protected
  CI workflows, and a disposable runner. Never mount a host container socket
  into the builder.

## Incident response

Stop the runner and revoke/rotate potentially exposed provider or tracker
credentials. Preserve the private runtime database and logs for investigation,
but treat them as potentially sensitive despite redaction. Disable the affected
repository's automation and auto-merge; inspect branch/PR/evidence objects and
audit events; notify affected maintainers/users under the disclosure policy.
Report vulnerabilities privately using [`SECURITY.md`](../SECURITY.md); do not
put exploit details or credentials in a public issue.
