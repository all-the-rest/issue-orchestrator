# Configuration

This page describes the JSONC config used by the GitHub V1 ticket-to-agent path
and the retained legacy `run --once` workflow. See
[`architecture.md`](architecture.md) for the responsibility split.

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
- `agent_runner`: optional selected AgentRunner name; defaults to `opencode`.
- `command_runner`: optional trusted executable configuration used when
  `agent_runner` is `command`; fields are `executable`, optional `args`, and
  optional `timeout_ms` (default 30 minutes, maximum one hour).
- `accounts`: optional unique account-name array; an enabled repo needs an
  account, selected from its `account` or the first configured account.
- `trusted_authors`: optional username array.
- `tool_authors`: optional usernames to exclude from ticket comment inputs (the
  configured GitHub accounts are excluded automatically).
- `max_concurrency`: optional positive integer (default `1`).
- `provider`, `tracker`, `code_host`: legacy workflow provider selectors
  (`github`, `gitlab`, or `jira`). Legacy `provider` selects both tracker and
  code host; they may instead be selected independently. V1 `/goal` requires
  the GitHub tracker.
- `defaults`: optional defaults object. `enabled` (default true),
  `local_only` (default false), `auto_merge` (default true), provider and agent
  runner selectors, `command_runner`, and label mappings can be set here.
- `labels`: optional label-name mapping.
- `merge.method`: optional `squash`, `merge`, or `rebase` (default `squash`).
- `evidence.branch_prefix`: optional safe branch prefix (default
  `agent-evidence`).

Repository fields include `account`, `tracker_account`,
`code_host_account`, `provider`, `tracker`, `code_host`, and
`code_host_project`; `enabled`, `local_only`, and `auto_merge` booleans;
`base_branch` (default `main`); `trusted_authors`; `tool_authors`; `labels`;
`agent_runner`; `command_runner`;
`max_concurrency`;
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

For `/goal`, `labels.auto_implement` selects auto-implement mode and defaults to
`agent:auto-implement`; set it globally, under `defaults`, or for one repo to
use a different label. Without the label, the command publishes a human-directed
`REVIEW` status and starts no agent. `agent_runner` may be selected globally,
under `defaults`, or per repository. Selection precedence is repository,
top-level, `defaults`, then `opencode`. `command_runner` uses the same precedence
and its executable/arguments must be trusted configuration, never ticket data.
The configured `model` and selected runner are used for the persisted ticket
conversation. Both built-in runner adapters execute on Linux and macOS only.

The legacy `run --once` path still uses `auto_merge` for its CLI-owned merge
flow. The `/goal` ticket handoff passes the configured merge policy to the
selected integration, but does not perform CI checks or merge itself. Manual
merge restrictions must be enforced through provider permissions/branch
protection, never by relying on prompt text. In manual mode the selected agent's
credentials must not have merge authority, or the GitHub ruleset must withhold
it; setting `auto_merge: false` only changes the policy delivered by this bridge.
