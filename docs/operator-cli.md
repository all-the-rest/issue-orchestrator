# Operator CLI surface

`doctor --json` emits `{ "schema_version": 1, "checks": [...] }`. Each check
has `name`, `status` (`ok`, `failed`, or `missing`), and a sanitized `message`;
disk adds `available_bytes`, SQLite adds `path`. `jobs list --json` emits an
array; `jobs show <id> --json` emits one job object with persisted queue/workflow
state, attempts, branch, change number, head/evidence commits, error class,
updated time, and artifact evidence (`kind`, hashes, creation time). Ownership
tokens, process IDs, and credentials are never included. GitHub/GitLab checks
only run when a configured project uses that provider and compare the active
CLI identity with the accounts configured for those projects. `opencode` and
`git` are version probes; model selection is compared with OpenCode's configured
default model. SQLite is opened and migrated if needed. Disk reports available
bytes for the runtime directory. Doctor does not contact model APIs or prove
that provider credentials are accepted by a remote service.

`status --json` emits the existing status object with `database_path`,
`queue_counts` (job-state names to counts), `active_leases` (job id, project,
lease expiry and an `expired` boolean), and `next_run` (currently always `null`, because no scheduler is
implemented), alongside config, active lock, last run, and reconciliation data.
`jobs list --json` returns up to 100 jobs ordered by most recently updated;
`jobs show <id> --json` returns one job. Both expose persisted workflow/queue
state, attempts/max attempts, branch, change number, head and evidence commit,
error class (`last_error`), update time, title/URL, pull-request number, and
artifact hashes. Queue counts include every known job state with zero-filled
counts. These commands never
return owner tokens or agent process identity.

Exit statuses are 0 for all checks passing, 1 for a failed/refused command, 2
for invalid configuration, and 8 for pending checks. `doctor` executes only
local version/identity probes, performs no account switch, and suppresses raw
provider output. The currently supported mutation surface does not include
operator retry/cancel or project configuration editing: these require safe
workflow transition and comment-preserving JSONC semantics not yet exposed by
the persistence/config APIs. `logs` is likewise not exposed because arbitrary
session paths cannot yet be safely constrained to a private operator log root.
