# Contributing

Thanks for helping improve Issue Orchestrator. This repository currently
targets GitHub; GitLab/Jira support and npm publishing are not part of this
contribution workflow.

## Development

- Use Node.js 24 or newer and pnpm 11.23.0 (the version is pinned in
  `package.json`).
- Install dependencies with `pnpm install`.
- Run the project suite with `pnpm test` (it builds first), and use
  `pnpm typecheck` for a focused type check.
- The default test suite is hermetic and does not need provider credentials or
  network access. Optional container tests have additional prerequisites; see
  `docs/providers.md` and `README.md`.
- Do not include credentials, real customer data, or generated build artifacts.

### Test runner

`pnpm test` lints and builds first, then runs the standalone scripts listed in
`test/run-parallel.mjs`. Those scripts are hermetic (each one that touches the filesystem works in its
own `mkdtempSync` directory and none changes the shared cwd), so the runner starts
up to four at a time and prints one buffered stdout/stderr block per script when
it finishes. Set `TEST_CONCURRENCY` (1–8) to change the limit.

- The runner fails fast: after the first failing script no new script starts,
  already running ones are awaited, and the run exits non-zero with a list of
  the failed scripts.
- For a local partial run, pass scripts from the canonical list, e.g.
  `pnpm build && node test/run-parallel.mjs test/persistence.mjs test/e2e.mjs`.
  The list in `test/run-parallel.mjs` is authoritative; it mirrors the same
  scripts and order that previously formed a sequential `&&` chain.
- `test/test-parallel.mjs` self-tests the runner with throwaway scripts via
  `TEST_FILES`; that override exists only for this self-test and cannot target
  the runner itself.

## Changes and review

Open a GitHub issue for substantial proposals and submit changes as a pull
request. Do not push directly to `main`: the active ruleset requires a PR and
green required checks. Before requesting review, inspect the complete proposed
range against its base (not only the final commit), run applicable checks, and
explain behavior, risks, and any checks that could not be run. Keep changes
focused and update documentation/tests when behavior changes.

The required contexts and Ratchet baseline policy are documented in
[`docs/quality-gates.md`](docs/quality-gates.md). When a second human maintainer
is unavailable, follow its independent full-range review procedure and record
the verdict/evidence in the PR. Do not raise a Ratchet baseline without the
required rationale and generated change.
