# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's **Report a
vulnerability** flow for this repository. Include the affected version/commit,
impact, and a minimal reproduction. Do not include live credentials or customer
data. If private reporting is unavailable, contact maintainers through a
previously verified private channel. We will acknowledge reports and coordinate
a fix and disclosure timeline with the reporter.

## Sandbox boundary

Builder shell commands run in a disposable OCI container with no network, host
home, tracker CLI, SSH agent, or mounted host credentials. The OpenCode process
itself runs under the orchestrator user's host identity; environment and tool
permissions are defense-in-depth, **not OS-level isolation**. This project does
not claim unattended operation is safe on a workstation containing valuable
secrets. See [`docs/threat-model.md`](docs/threat-model.md) for controls,
residual risks, operational requirements, and non-goals.
