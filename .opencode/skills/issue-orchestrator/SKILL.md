---
name: issue-orchestrator
description: Run one Issue Orchestrator cycle by delegating to the installed CLI and reporting its result.
---

# Issue Orchestrator

This is only a wrapper around the installed `@all-the.rest/issue-orchestrator`
CLI. Do not duplicate its workflow or make provider changes yourself.

Run:

```sh
issue-orchestrator run --once
```

If the user specifies a configured project, append `--project <owner/repo>`.
Use `--dry-run` only when the user asks for a preview. Do not invent project
configuration or retry refused/failed runs. Report stdout (JSON for normal
outcomes) and the exit status verbatim; include stderr for errors. If the
executable is unavailable, report that prerequisite instead of substituting
another workflow.
