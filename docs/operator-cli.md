# Operator CLI surface

`doctor --json` emits `{ "schema_version": 1, "checks": [...] }`; checks have
`name`, `status` (`ok`, `failed`, or `missing`), and sanitized `message`.
`status --json` contains config, database path, zero-filled queue counts, active
leases, `next_run: null`, last run, and reconciliation status. `jobs list --json`
returns up to 100 sanitized job objects; `jobs show <id> --json` returns one.
Neither includes ownership tokens, process identity, or credentials.

`jobs cancel <id>` atomically cancels only a `READY` queued job; active and
terminal jobs are refused. `jobs retry <id>` creates a new `READY` row and
retains the failed row/history. It is permitted only for a `FAILED` job below
`max_attempts`, without branch/change/head/evidence identifiers, artifacts, or
side-effect journal entries, and while no job is active. It does not skip the
normal claim and merge gates. Mutations take the queue mutation guard but do not
reconcile providers.

`logs [--job <id>] [--follow] [--json]` maps persisted sessions to the private
`${dirname(databasePath())}/agent-sessions/<session-id>/` directory. Only fixed
`events.ndjson` and `stderr.log` files are read; symlinks and non-regular files
are rejected, each initial read is limited to the last 64 KiB, and follow chunks
are limited to 16 KiB. Missing logs produce no entry. JSON snapshot shape is
`{ "schema_version": 1, "logs": [{ "session_id", "kind", "content" }] }`.
With `--follow --json`, the initial snapshot is followed by JSON Lines append
events `{ "schema_version": 1, "event": "append", "session_id", "kind", "content" }`;
Ctrl-C ends the stream. Logs never expose agent process credentials.

`project add <id> --from <existing>` clones a validated project definition;
`project remove <id>` refuses to remove the last project; `pause` and `resume`
set the project's `enabled` flag. Updates preserve unrelated config text and
comments, validate a same-directory temporary file, preserve mode, then atomically
replace the original. Project commands use the global mutation guard, so
orchestrator CLI writers are serialized; an inode/content check also rejects
changes observed before replacement. The CLI cannot coordinate with arbitrary
external editors, so do not edit the same config concurrently. Unsafe or
unlocatable edits fail without changing the file.

Exit statuses are 0 for success, 1 for refused/failed commands, 2 for invalid
configuration, and 8 for pending checks. `doctor` performs local probes only;
it never switches provider accounts or contacts model APIs.
