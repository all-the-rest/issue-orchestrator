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
