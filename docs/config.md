# Configuration

This page describes the **currently implemented** JSONC config on `main`. The
ticket/agent configuration adopted in
[issue #53](https://github.com/all-the-rest/issue-orchestrator/issues/53) is
pending migration. Its fields and commands are not supported by the current
schema; no finished target schema is specified here. See
[`architecture.md`](architecture.md) for the current/target responsibility
split.

## Location and format

By default config is `~/.config/issue-orchestrator/config.jsonc`. Set
`ISSUE_ORCHESTRATOR_CONFIG` or pass `--config <path>` to select another file.
The parser accepts JSONC line/block comments and trailing commas. Credentials
belong in the provider credential store, not this file; credential-like fields
and known token values are rejected.

## Current schema

The following is a shape overview, not a complete copy-paste config. `model`
and a nonempty `repos` object are required. Every repository requires `dod`
with all five command categories, a nonempty unique list of exact required
check names, an evidence class, and an acceptance source. See
[`providers.md`](providers.md) and the README's [DoD example](../README.md#project-definition-of-done)
for current behavior and examples.

Top-level fields:

- `model`: required `provider/model` string.
- `repos`: required nonempty object keyed by `owner/repository`.
- `accounts`: optional unique account-name array; an enabled repo needs an
  account, selected from its `account` or the first configured account.
- `trusted_authors`: optional username array.
- `max_concurrency`: optional positive integer (default `1`).
- `provider`, `tracker`, `code_host`: optional provider selectors (`github`,
  `gitlab`, or `jira`). Legacy `provider` selects both tracker and code host;
  they may instead be selected independently.
- `defaults`: optional defaults object. `enabled` (default true),
  `local_only` (default false), `auto_merge` (default true), provider
  selectors, and label mappings can be set here.
- `labels`: optional label-name mapping.
- `merge.method`: optional `squash`, `merge`, or `rebase` (default `squash`).
- `evidence.branch_prefix`: optional safe branch prefix (default
  `agent-evidence`).

Repository fields include `account`, `tracker_account`,
`code_host_account`, `provider`, `tracker`, `code_host`, and
`code_host_project`; `enabled`, `local_only`, and `auto_merge` booleans;
`base_branch` (default `main`); `trusted_authors`; `labels`; `max_concurrency`;
`resource_locks`; `merge_method`; `evidence.branch_prefix`; and required `dod`.
Repository values override applicable defaults/global provider selections.
The legacy repo `provider` fills either port that has no more specific
selection. Account credentials are not stored in config.

`dod.commands` has `build`, `test`, `lint`, `typecheck`, and `security`, each a
nonempty argv array or `null` to skip; commands run without a shell.
`dod.required_checks` is a nonempty unique array of check names.
`dod.evidence_class` is `ui`, `cli`, or `docs`; `dod.acceptance_source` is
`issue_body` or `triage_comment`; optional `dod.timeout_ms` is an integer from
1 through 3,600,000 (default 300,000). For `triage_comment`, current behavior
requires exactly one marked acceptance comment from a trusted author.

The current implementation's `auto_merge` controls its CLI-owned merge path;
it defaults true for enabled repos, subject to existing approval, marker,
DoD, and required-check gates. It is separate from the target policy in issue
#53, where the selected agent integration owns merge and provider permissions
enforce manual mode. Do not infer that the target configuration is available
from the similarly named current field.
