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
and a busy timeout; work claims and event enqueueing are transactional.
If a legacy `lock.json` is malformed, normal commands fail closed; after
verifying the old run has stopped, `release --force --confirm-stale` archives
the malformed lock and matching state file instead of deleting them.

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
