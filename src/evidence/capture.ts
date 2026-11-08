import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** Portable stdout/stderr tee capture. Arguments are passed verbatim without a shell. */
export function captureCommand(argv: string[], output: string) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((arg) => typeof arg !== 'string' || !arg || arg.includes('\0'))) {
    throw new Error('capture requires a non-empty command argv');
  }
  const target = path.resolve(output);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(target, 'wx', 0o600);
  let ended = false;
  let descriptorOpen = true;
  return new Promise<number>((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { shell: false, stdio: ['inherit', 'pipe', 'pipe'] });
    const closeDescriptor = () => {
      if (!descriptorOpen) return;
      descriptorOpen = false;
      fs.closeSync(fd);
    };
    const fail = (error: Error) => {
      if (ended) return;
      ended = true;
      child.kill('SIGKILL');
      closeDescriptor();
      reject(error);
    };
    const record = (stream: NodeJS.ReadableStream, destination: NodeJS.WriteStream) => {
      stream.on('data', (chunk: Buffer) => {
        if (ended) return;
        try {
          fs.writeSync(fd, chunk);
          destination.write(chunk);
        } catch (error) {
          fail(error as Error);
        }
      });
    };
    record(child.stdout!, process.stdout);
    record(child.stderr!, process.stderr);
    child.once('error', (error) => {
      fail(error);
    });
    child.once('close', (code) => {
      if (ended) return;
      ended = true;
      closeDescriptor();
      const result = { command: argv, exit_code: code ?? 1 };
      fs.writeFileSync(`${target}.json`, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      resolve(code ?? 1);
    });
  });
}
