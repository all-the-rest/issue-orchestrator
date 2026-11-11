# Synthetic sample project

Use `example-org/sample-project` as a documentation-only sample when learning
the GitHub-only V1 handoff. Create a GitHub issue with the title you want to
keep; do not add a title prefix. Without the configured `agent:auto-implement`
label, the `goal` command records a human-directed `REVIEW` outcome and starts
no agent.
Adding the opt-in label allows the selected project agent integration to receive
the structured issue, human comments, and exact final acceptance criteria.

Copy [`../config.jsonc`](../config.jsonc) to a private config location, replace
the model/account/project values, and set `enabled` to `true` only after the
configured identity and provider permissions are correct. Authenticate with the
GitHub CLI outside the config; never put credentials in this example or in
issue text.
Run `issue-orchestrator goal` from a checkout of that configured repository:
the current working tree is passed to the selected integration, and its GitHub
`origin` must match the configured project. Use a dedicated worktree/branch for
auto-implementation.
