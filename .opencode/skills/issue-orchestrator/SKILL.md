---
name: issue-orchestrator
description: Hand explicit final acceptance criteria to the configured GitHub issue agent through the installed CLI.
---

# Issue Orchestrator

This is only a wrapper around the installed `@all-the.rest/issue-orchestrator`
CLI. Do not duplicate its workflow or make provider changes yourself. V1 accepts
GitHub issues only; do not route to GitLab or Jira.

Run the installed CLI:

```sh
issue-orchestrator goal --project <owner/repo> --issue <number> --goal-file <private-file>
```

Run from a checkout whose `origin` matches the configured GitHub project; this
working tree is passed to the selected integration. From a source checkout,
invoke the built CLI by its path while staying in the target project checkout:

```sh
node /path/to/issue-orchestrator/dist/cli.js goal --project <owner/repo> --issue <number> --goal-file <private-file>
```

Ask for the configured GitHub project, issue number, and exact final acceptance
criteria if they are missing. Write the exact criteria to an owned private
temporary file with mode `0600`; never put the criteria in command arguments.
Do not invent project configuration or change the issue title. Report stdout
(JSON for normal outcomes) and the exit status; include stderr for errors. Do
not claim CI passed or that the CLI authorized a merge. If neither CLI is
available, report that prerequisite instead of substituting another workflow.
