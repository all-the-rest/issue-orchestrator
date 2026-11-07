# Provider ports and capabilities

The orchestration core selects three independent ports: a **Tracker** for work
items, a **CodeHost** for branches/change requests/reviews/checks/evidence, and
an **AgentRunner** for agent sessions. Adapters export a capability descriptor;
the descriptor is descriptive, not a permission to skip a gate. Calling a
missing operation throws `UnsupportedCapabilityError` and stops the workflow.

| Adapter | Port | Work items | Labels/comments | Change requests | Checks | Native approval | Merge | Evidence URLs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GitHub | Tracker | Yes | Yes | — | — | — | — | — |
| GitHub | CodeHost | — | Change comments | Yes (PRs) | Required checks | Yes | squash, merge, rebase | branch + raw URL |
| GitLab | Tracker | Stub; fails closed | Stub; fails closed | — | — | — | — | — |
| GitLab | CodeHost | — | Stub; fails closed | Stub; fails closed | Stub; fails closed | No | None | None |
| Jira | Tracker | Stub; fails closed | Stub; fails closed | — | — | — | — | — |
| Jira | CodeHost | — | Stub; fails closed | Not supported | Not supported | No | None | None |
| OpenCode | AgentRunner | — | — | — | — | — | — | Session/run/resume/abort/result are currently a fail-closed port stub |

Jira has no pull requests or checks. Pair it with a code host explicitly, for
example `"tracker": "jira", "code_host": "github"`; this is accepted by the
configuration schema, but Jira operations remain unavailable until its adapter
is implemented. The GitHub code host is not inferred from a Jira tracker.

## Configuration

The legacy `provider` key remains supported and selects both ports. New configs
may select them independently at the global, defaults, or repository level:

```jsonc
{
  "accounts": ["reisi007"],
  "tracker": "jira",
  "code_host": "github",
  "repos": {
    "reisi007/demo": { "account": "reisi007", "enabled": true }
  }
}
```

Repository-level values override defaults and global values. A repository's
legacy `provider` value fills either port that has no repository-level explicit
selection. The legacy `account` remains the fallback for both `tracker_account` and
`code_host_account`; those fields may be set independently when needed. Provider
credentials stay in the provider CLI/credential store, never in config.

The selected tracker/code-host pair is persisted with active work and checked
during recovery. Changing the pair while a journaled write is pending therefore
leaves the effect uncertain instead of replaying it against a different system.
