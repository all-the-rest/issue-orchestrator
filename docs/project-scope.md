# Project goal and scope

`issue-orchestrator` is a **GitHub-event gateway to OpenCode**. Its router
selects activity allowed by the configured trust policy, persists the mapping
from each issue to its OpenCode session, and forwards compact event metadata so
the corresponding OpenCode agent can continue the work.

## Supported flow

1. The router reads GitHub issue/PR event identities, authors, timestamps and
   URLs, then applies the configured trusted-author and tool-account filters.
2. It persists event cursors and sends only the accepted metadata to the
   persistent OpenCode session. Ticket and comment bodies are not routing
   payloads; the ticket agent fetches GitHub context itself with its configured
   `gh` authority.
3. The agent performs repository work and GitHub writes itself. The router
   consumes only the validated, bounded terminal result needed to record the
   workflow outcome and continue routing.

That bounded result is not an interactive reverse conversation channel. The
router does not relay arbitrary agent text back and forth or expose an
OpenCode `question` tool; ticket-agent human questions use the configured
GitHub workflow instead.

## OpenCode owns its runtime

OpenCode and its operator own provider login, credential refresh/export, and
OpenCode's internal session database. If a provider rejects authentication,
issue-orchestrator reports the agent run as failed through its normal result
path. It does not log into the provider, refresh or rewrite credentials, reset
or delete OpenCode's private session database, or implement provider-specific
authentication recovery. The operator resolves the problem in OpenCode and
uses the existing retry/workflow controls as appropriate.

This boundary does not change ordinary at-least-once event delivery or generic
runner failure handling. It excludes special auth remediation and an
agent↔router interactive protocol.

## Non-goals

- Managing or repairing OpenCode provider authentication or private session
  storage.
- Interpreting provider errors and autonomously changing credentials or
  OpenCode state.
- Providing a general-purpose bidirectional agent chat/control channel.
- Forwarding GitHub issue, comment, review, or diff bodies as router event
  payloads.

The ticket agent may still use its explicitly configured GitHub permissions to
read issues and publish repository changes. That authority belongs to the agent
inside OpenCode, not to the router's event-forwarding role.
