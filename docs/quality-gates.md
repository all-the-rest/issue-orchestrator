# Quality gates and main-branch policy

## Required checks on `main`

The active `Protect main` ruleset targets `refs/heads/main`, requires pull
requests and up-to-date branches, and has no bypass actors. It requires these
GitHub Actions status contexts:

| Required context | What it gates |
| --- | --- |
| `test (ubuntu-latest)` | Full test suite, production dependency audit, pinned Ratchet fast tier |
| `test (macos-latest)` | Full suite, production audit, Ratchet fast tier, launchd plist validation |
| `docker-image` | Source-only image build and packaged runtime checks |
| `service-linux-container` | Service behavior in the Ubuntu container |
| `gitleaks` | Repository secret scan |

Ratchet is a step in each `test (...)` matrix job, not a separate GitHub check
context. A failed `ratchet check` fails both contexts; there is no standalone
`Ratchet fast` status to add as a required check. The contexts above are the
actual check-run names emitted by `.github/workflows/ci.yml`.

## Run Ratchet locally

When Ratchet v0.6.3 is installed, run:

```sh
ratchet check --config=ratchet.config.jsonc --tier=fast
```

CI pins Ratchet at v0.6.3, installs its platform binary through
`.github/scripts/install-ratchet.sh` with checksum verification, and appends a
Markdown report to the Actions job summary after a successful check. If the CLI
is unavailable or a different version is installed, CI is authoritative; merge
only after every required context is green.

## Baseline changes

Ratchet limits are ceilings. Do not raise one just to make a failing change pass.
For an intentional increase, use the CLI and include the generated baseline
change in the PR:

```sh
ratchet baseline raise --rule <rule-id> --value <n> --reason "<why>"
```

The PR must record the rule, previous and proposed values, concrete reason, and
why reducing or restructuring the counted code is not appropriate. Review the
baseline diff as part of the full PR range; normal CI and the Ratchet gate must
still pass. Never edit a baseline silently or bundle an unexplained increase.

## One-maintainer review policy

When a second human maintainer is unavailable, obtain an independent full-range
review before push, then verify every required CI context is green before merge.
Record the review verdict and evidence in the PR.
The ruleset intentionally requires zero native GitHub approvals: a sole PR
author cannot approve their own change. Independent review plus green required
checks is the documented one-maintainer exception; review is procedural and is
not represented as a GitHub approval check.
