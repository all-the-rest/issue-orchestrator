# issue-orchestrator

Provider-independent CLI that turns trusted issues into reviewed, evidenced
change requests. The deterministic work — queue, state, labels, git, gates,
evidence, merge checks — belongs in software. The LLM does only the semantic
work: triage, implementation, verification and review.

OpenCode is the first agent backend, not a dependency of the core.

> **Status:** early `v0.1`. The deterministic core has been extracted from the
> `git-issue-agent` skill. SQLite persistence is in place; the `run` loop and
> agent runner land in follow-up issues of milestone `v0.1`.

## Requirements

- Node.js 24 or newer
- pnpm 11 (`packageManager` is pinned in `package.json`)
- `git`
- the provider CLI you configure: `gh` for GitHub, `glab` for GitLab (later)

## Development

```sh
pnpm install
pnpm build
pnpm test
node dist/cli.js --help
```

The end-to-end suite is hermetic: a fake `gh` prints fixture JSON and a local
bare repository stands in for the remote, so no network or credentials are
needed. It runs on macOS and Linux in CI.

## Usage

```sh
issue-orchestrator status
issue-orchestrator list
issue-orchestrator claim <project> <issue>
issue-orchestrator checkpoint <stage> --owner-token <token>
issue-orchestrator release --owner-token <token>
```

Run `issue-orchestrator --help` for the full command list. All commands accept
`--config <path>`; commands that print text by default accept `--json`.

Exit codes: `0` done/green, `1` refused/failed, `2` config missing or invalid,
`8` checks pending.

Configuration lives in `~/.config/issue-orchestrator/config.jsonc` unless
`ISSUE_ORCHESTRATOR_CONFIG` or `--config` points elsewhere. Runtime data lives
in `orchestrator.sqlite3` under `ISSUE_ORCHESTRATOR_HOME`; all configs share
that transactional queue. Existing `state.json` and `lock.json` files are
imported once on first use. SQLite uses WAL, foreign keys,
and a busy timeout; work claims and event enqueueing are transactional. The
additive schema migration stores guarded workflow state separately from the
queue/lease state, with an actor/reason transition log and a durable
side-effect intent/result journal. Existing checkpoint stages are mapped during
migration.
The CLI claim records only `CLAIMED`; `checkpoint triaged` is the agent's
explicit progress report and advances the workflow before isolation.
If a legacy `lock.json` is malformed, normal commands fail closed; after
verifying the old run has stopped, `release --force --confirm-stale` archives
the malformed lock and matching state file instead of deleting them.

GitHub label/comment, change-request, merge, and evidence writes are journaled
before execution. Resume paths inspect the corresponding live tracker state or
remote evidence branch before retrying; an unknown external result fails closed
instead of blindly repeating a write. Evidence branches use stable
job-scoped idempotency keys and are validated against their remote manifests.
Every CLI startup, including `status`, reaps expired leases and inspects pending
journal entries; it never repeats an unverified provider write. For a verified
merged PR whose workflow finalization crashed, recovery retains a job owner,
journals the working-to-done label updates, and clears the queue only after
those updates are confirmed. Thus `status` may make these journaled tracker
updates. An unavailable provider leaves recovery active for retry. Other
confirmed effects are marked complete, absent effects stay pending for their
owning command to resume, and unavailable or mismatched observations are marked
uncertain and shown by `status`. A normal merge keeps its lock for
`release --result done`.
Comment recovery requires both the
configured actor and an exact hash of the rendered comment. Label setup repairs
existing color/description drift. Evidence inspection requires a matching local
Git worktree/origin; without one, the result stays uncertain for recovery from
the owning worktree. Evidence intents pin the locally prepared manifest/file
hashes and a random job-specific branch suffix, so a self-consistent but
unrelated ref is not adopted. PR reuse inspects all states and refuses lookups
that reach its 1,000-result safety cap rather than assume the match set is
complete. GitLab remains an unimplemented provider slot.
Actor values guard internal transitions, but they are local process roles, not
cryptographic identities; trusted human approval is established from the
configured GitHub reviewer checks.

## Architecture

```
src/cli.ts        argument dispatch, --help/--version
src/core/         commands, config, SQLite persistence and migrations
src/providers/    Tracker/CodeHost adapters (github implemented, gitlab slot)
src/evidence/     artifact validation, secret scanning, evidence publishing
```

The roadmap and architecture decisions live in the pinned issue on GitHub.

## License

Apache-2.0
