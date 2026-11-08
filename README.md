# issue-orchestrator

Provider-independent CLI that turns trusted issues into reviewed, evidenced
change requests. The deterministic work — queue, state, labels, git, gates,
evidence, merge checks — belongs in software. The LLM does only the semantic
work: triage, implementation, verification and review.

OpenCode is the first intended agent backend, not a dependency of the core.

> **Status:** early `v0.1`. The deterministic core has been extracted from the
> `git-issue-agent` skill. SQLite persistence, the replaceable OpenCode
> `AgentRunner`, and a first `run --once` orchestration slice are in place. The
> run loop currently supports GitHub with OpenCode; other provider adapters
> remain fail-closed stubs. Agent builder commands run only through the
> disposable OCI sandbox and fail closed unless the fixed Node 24/pnpm image is
> already present.

## Requirements

- Node.js 24 or newer
- pnpm 11 (`packageManager` is pinned in `package.json`)
- `git`
- Docker or Podman with `issue-orchestrator-builder:node24-pnpm11.23.0` preloaded for builder sessions
- the provider CLI you configure: `gh` for GitHub (GitLab and Jira adapters are fail-closed stubs)

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
issue-orchestrator run --once [--project <owner/repo>] [--dry-run]
issue-orchestrator claim <project> <issue>
issue-orchestrator checkpoint <stage> --owner-token <token>
issue-orchestrator dod verify <project> <issue> --owner-token <token> [--plan]
issue-orchestrator evidence <project> <issue> --dir <dir> --owner-token <token>
issue-orchestrator release --owner-token <token>
```

Run `issue-orchestrator --help` for the full command list. All commands accept
`--config <path>`; commands that print text by default accept `--json`.

`run --once` resumes an active claim or selects one open issue from enabled
repositories, ordered by configured severity and age, and skips issues without
a configured trusted author. It isolates work in a private runtime Git
worktree, runs triage, baseline and after verification, an OCI-isolated builder,
the configured DoD commands, evidence publication, and an independent review.
The issue body or the configured trusted triage comment is passed to agents as
acceptance data, not executable instructions. Use `--project` to restrict issue
discovery. `--dry-run` prints the selected issue and plan without opening or
mutating SQLite, claiming work, creating a branch, or writing to GitHub.

Possible JSON outcomes include `NO_ISSUE`, `DRY_RUN`, and `DONE`; `REVIEW`,
`BLOCKED`, and `NEEDS_INFO` hand the issue back for human action. Handover
preserves the branch/worktree and releases the queue claim. Unexpected failures
or unavailable dependencies fail closed and retain the active claim and
artifacts for recovery. Automatic merge is attempted only when enabled and
after the existing exact-head native-approval, machine-marker, DoD, and required
check gates pass. With `auto_merge: false`, the run always hands off for human
review.

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
complete. Provider ports, capability descriptors, configuration, and the
support matrix are documented in [`docs/providers.md`](docs/providers.md).
Actor values guard internal transitions, but they are local process roles, not
cryptographic identities; trusted human approval is established from the
configured GitHub reviewer checks.

## Project Definition of Done

Every repository must explicitly configure all five command categories, its
required CI check names, evidence class, and acceptance source:

```jsonc
{
  "repos": {
    "acme/service": {
      "account": "acme-bot",
      "dod": {
        "commands": {
          "build": ["pnpm", "build"],
          "test": ["pnpm", "test"],
          "lint": null,
          "typecheck": ["pnpm", "typecheck"],
          "security": null
        },
        "required_checks": ["CI", "Ratchet fast"],
        "evidence_class": "cli",
        "acceptance_source": "issue_body",
        "timeout_ms": 300000
      }
    }
  }
}
```

Command values are argv arrays executed directly with `shell: false`; `null`
explicitly skips a category. Omitted categories, empty/invalid argv, empty or
duplicate required checks, and unsupported enum values fail closed. `timeout_ms`
is optional (default 300000) and bounded to one hour. `dod verify` checks the
active issue lock, branch, clean worktree, and exact full head SHA before running
every configured command. It captures bounded stdout/stderr, exit code, signal,
and timeout status. `--plan` executes nothing and marks configured commands as
planned; skipped categories remain distinct. Reports are written privately to
the runtime directory; optional `--report <path>` must be outside the worktree.

For `acceptance_source: "triage_comment"`, exactly one issue comment must
contain `<!-- issue-orchestrator:acceptance -->` and be authored by a configured
trusted author. The text is recorded as data, never treated as instructions.
Evidence publication requires a successful, current, exact-head execution
report. The schema-2 manifest includes its evidence class and report; the issue
receives a journaled proof comment with SHA-pinned before/after artifact links,
commands/results, the evidence commit, exact source head, and change-request
link. Merge separately requires the nonempty provider-required check set plus
all configured required check names to be green. `auto_merge` remains true by
default; set it false per repository to leave merge approval to a human.

## Architecture

```
src/cli.ts        argument dispatch, --help/--version
src/core/         commands, config, SQLite persistence and migrations
src/providers/    Tracker/CodeHost/AgentRunner ports and provider adapters
src/git/          isolated Git process and origin operations
src/evidence/     artifact validation, secret scanning, evidence publishing
```

The roadmap and architecture decisions live in the pinned issue on GitHub.

## License

Apache-2.0
