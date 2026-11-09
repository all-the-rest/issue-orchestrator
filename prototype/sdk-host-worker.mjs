#!/usr/bin/env node
import { OpenCode } from '@opencode/sdk';

const [mode, id, dataDir, workspace] = process.argv.slice(2);
let host;
const send = (value) => process.send(value);
const shutdownRequested = new Promise((resolve) => {
  process.on('message', (message) => {
    if (message?.type === 'shutdown') resolve();
  });
});

try {
  const hostStarted = performance.now();
  host = await OpenCode.create({
    database: { path: `${dataDir}/opencode.db` },
    config: { directory: `${dataDir}/config` },
    fs: { filewatcher: false, fff: false },
    models: { fetch: false, snapshot: false },
  });
  const info = await host.server.info();
  const hostReadyMs = performance.now() - hostStarted;
  if (mode === 'create') {
    const started = performance.now();
    const session = await host.session.create({ id, title: 'SDK recovery prototype', location: { directory: workspace } });
    send({ type: 'ready', version: info.version, sessionId: session.id, hostReadyMs, createMs: performance.now() - started });
    await shutdownRequested;
    await host.close();
    host = undefined;
    send({ type: 'closed' });
    process.disconnect();
  } else if (mode === 'get' || mode === 'hold') {
    const started = performance.now();
    const session = await host.session.get({ sessionID: id });
    send({ type: mode === 'hold' ? 'held' : 'recovered', version: info.version, sessionId: session.id, hostReadyMs, queryMs: performance.now() - started });
    if (mode === 'get') {
      await host.close();
      host = undefined;
      process.disconnect();
    } else {
      await shutdownRequested;
      await host.close();
      host = undefined;
      send({ type: 'closed' });
      process.disconnect();
    }
  } else {
    throw new Error('Unknown worker mode');
  }
} catch (error) {
  send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  if (host) await host.close().catch(() => {});
}
