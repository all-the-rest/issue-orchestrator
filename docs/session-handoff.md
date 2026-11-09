# OpenCode session handoff

## Decision

Start a fresh implementation session in the target checkout and provide a short,
structured handoff. A chat transcript is not project state: the repository,
SQLite job record, committed artifacts and verified recovery metadata are the
sources of truth. A session handoff only transfers the minimum useful context.

This is the v0.1 migration contract. A real session move is not supported by the
installed CLI and is not required. Do not manipulate OpenCode's database, delete
the original session, or commit session exports, conversation logs or filled-in
private handoffs to the repository.

## Available approaches

| Approach | What it does | Limitation |
| --- | --- | --- |
| Continue: `opencode run --session <id>` | Continues the identified conversation; the CLI creates a session if that ID does not exist. | Continues context, not a project-directory move. Use only when continuing that session is appropriate. |
| Fork: `opencode run --session <id> --fork` | Forks the conversation before continuing; the original remains available. | Creates a related session, but does not transfer the project directory or make the forked context authoritative. |
| Fresh session + handoff (**recommended**) | Starts new context in the target checkout with explicit decisions, state, open issues and next action. | Requires a concise handoff; the repository and durable job state must still be checked. |

In OpenCode v2.2.6, `opencode session --help` lists `list`, `delete`, `export`
and `import`, but no `move`; `opencode run --help` documents `--session` and
`--fork`. OpenCode's HTTP API separately documents
[`POST /api/session/{sessionID}/move`](https://opencode.ai/docs/api/#tag-session).
That API operation is not a CLI session-migration contract and this product does
not need it. Export/import is not a move either. Never edit the OpenCode database
directly to simulate one.

## Handoff template

Copy only the relevant, sanitized fields into the new session prompt. Do not add
conversation transcripts, credentials, tokens, environment dumps, provider-auth
data, or unrelated private information. Leave unknown fields explicit rather
than guessing.

```markdown
# Implementation handoff

## Goal
- <issue number and acceptance outcome>

## Architecture decisions
- <decision> — <reason/source, such as issue or docs link>

## Repository state
- Repository/checkout: <path or repository name>
- Branch and base commit: <branch, commit SHA>
- Working-tree state: <clean, or concise list of relevant uncommitted paths>

## Completed and verified
- <change or checkpoint> — <command/result, or explicitly not verified>

## Open issues and constraints
- <issue number and remaining acceptance items>
- <safety, provider, or environment constraint; never include secret values>

## Next concrete step
- <one action that can be performed and verified>
```

Keep the original session unchanged. The next session should inspect the named
checkout and durable job state before acting; it must not treat the handoff as a
replacement for those sources of truth.

## References

- [OpenCode CLI](https://opencode.ai/docs/cli/)
- [OpenCode HTTP API](https://opencode.ai/docs/api/)
