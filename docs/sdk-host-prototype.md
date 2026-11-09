# Embedded OpenCode SDK host prototype

**Decision:** keep the production `opencode run --standalone --session` runner
as the default. This is an isolated feasibility spike only: it adds no
production adapter, setting, or runner behavior. The prototype uses the pinned
`@opencode/sdk@2.2.6` in a supervised Node child process, a private temporary
HOME/XDG data/config environment, and a temporary workspace. It sends only
bounded JSON readiness/result records over child-process IPC; stdout and stderr
are discarded, and the parent does not pass through the caller's environment or
credentials. No model prompt is run.

## What was demonstrated

The SDK's official [V2 SDK documentation](https://opencode.ai/docs/build/sdk) describes
`OpenCode.create()` as an owned embedded host, with no HTTP listener, and the
generated SDK client has the server and session API surface. In the pinned
2.2.6 declarations, `server.info()` is typed and `session.create()` accepts a
caller-provided `id`; `session.get()` retrieves by `sessionID`; `close()` closes
the owned host. The `server.info()` version field returned `unknown` in this
prototype run, so the pinned package version is the SDK version evidence.

Run the manual integration check with:

```sh
pnpm prototype:sdk-host-recovery
```

It writes and fsyncs the selected session ID file (mode 0600) and its parent
directory before launching the first child; creates and cleanly closes the host;
starts another host, confirms the same session, then SIGKILLs its detached
process group; waits for the child's close event and confirms its PID is gone
before launching the replacement host; finally retrieves the same session ID
from the same private data directory. Power-loss durability is not separately
simulated.
The test is intentionally not part of the ordinary `pnpm test` suite: it is an
opt-in integration check with several seconds of SDK host startup and substantial
SDK dependency footprint.

Latest recorded run on Linux, Node v26.10.0, SDK 2.2.6 (MemAvailable before
run: 3,630,028 kB): first host startup plus readiness and session creation took
3.21 s (host startup/readiness 169 ms; session create 43 ms); replacement host
startup/readiness took 128 ms and lookup 7 ms (2.43 s end-to-end). These are
single-run observations, not a benchmark and not evidence that the SDK is faster
than the CLI. Earlier runs recorded different timings. The install added
approximately 366 MB to `node_modules` in this checkout; no runtime or prompt
cost was incurred.

## Install-script policy

The default global pnpm here is 12.9.1, whereas the project pins pnpm 11.23.0.
`corepack` is unavailable, so the pinned CLI was run as
`npx --yes pnpm@11.23.0`. A frozen install initially rejected the optional
`@parcel/watcher` install script. The narrowly scoped command
`pnpm approve-builds @parcel/watcher` (not `--all`) generated
`pnpm-workspace.yaml` with only `@parcel/watcher: true` in `allowBuilds`.
That package's install script delegates to `node scripts/build-from-source.js`;
it invokes node-gyp only when `npm_config_build_from_source=true`, which was not
set. The install script completed without compiling native source. A subsequent
`npx --yes pnpm@11.23.0 install --frozen-lockfile` passed. This is deliberately
package-scoped approval; no other dependency install scripts are approved.

The full `pnpm audit` (including development dependencies) reported three
transitive advisories through SDK 2.2.6: one high-severity Zod advisory and two
moderate advisories in `glob` and `minimatch`. The production-only audit does not
include this development dependency. This is additional evidence against
shipping the SDK as a production dependency without an updated upstream
dependency tree.

## Remaining gates

This establishes basic embedded-host startup, ID selection, normal close, and
session lookup after an abrupt host-child death. It does **not** prove recovery
of an in-flight model prompt, prompt abort semantics, model latency, provider
cost behavior, or correctness under concurrent execution. It does not test the
production OCI builder boundary, least-privilege agent configuration, credential
handling for a real provider, or SDK behavior on Node 24 / macOS. Process-group
termination was exercised on Linux; the script supports Linux/macOS but macOS
was not tested. This is not a production process-identity/recovery protocol:
there is no durable PID/start-time
identity check, descendant audit, or protection against PID reuse. These remain
required before replacing the existing CLI supervisor. No production routing or
configuration switch is introduced by this spike.
