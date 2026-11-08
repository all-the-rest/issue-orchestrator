import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateEvidenceDirectory } from '../dist/evidence/index.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-validation-'));
const dir = path.join(root, 'evidence');
const put = (side, name, bytes) => {
  const parent = path.join(dir, side);
  fs.mkdirSync(parent, { recursive: true });
  fs.writeFileSync(path.join(parent, name), bytes);
};
const invalid = [
  ['bad.png', Buffer.from('89504e470d0a1a0a', 'hex')],
  ['bad.jpg', Buffer.from('ffd8ff00', 'hex')],
  ['bad.gif', Buffer.from('GIF89a')],
  ['bad.webp', Buffer.from('RIFF\0\0\0\0WEBP')],
  ['bad.mp4', Buffer.from('\0\0\0\x08ftyp')],
  ['bad.webm', Buffer.from('1a45dfa3', 'hex')],
  ['empty.log', Buffer.alloc(0)],
];
try {
  for (const [name, bytes] of invalid) {
    fs.rmSync(dir, { recursive: true, force: true });
    put('before', 'state.log', Buffer.from('before'));
    put('after', name, bytes);
    assert.throws(() => validateEvidenceDirectory(dir, 1), /Invalid|empty/ , name);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  put('before', '.hidden', Buffer.from('private'));
  put('after', 'state.log', Buffer.from('after'));
  assert.throws(() => validateEvidenceDirectory(dir, 1), /hidden/);
  fs.rmSync(dir, { recursive: true, force: true });
  put('before', 'state.log', Buffer.from('before'));
  put('after', 'state.log', Buffer.from('after'));
  fs.symlinkSync(path.join(dir, 'before', 'state.log'), path.join(dir, 'after', 'linked.log'));
  assert.throws(() => validateEvidenceDirectory(dir, 1), /symbolic-link/);
  fs.rmSync(dir, { recursive: true, force: true });
  put('before', 'state.log', Buffer.from('before'));
  fs.mkdirSync(path.join(dir, 'after'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'after', 'oversized.log'), 'x');
  fs.truncateSync(path.join(dir, 'after', 'oversized.log'), 50 * 1024 * 1024 + 1);
  assert.throws(() => validateEvidenceDirectory(dir, 1), /below 50 MB/);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'before'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'after'), { recursive: true });
  for (const side of ['before', 'after']) {
    const file = path.join(dir, side, 'large.log');
    fs.writeFileSync(file, 'x');
    fs.truncateSync(file, 50 * 1024 * 1024);
  }
  fs.writeFileSync(path.join(dir, 'after', 'small.log'), 'x');
  assert.throws(() => validateEvidenceDirectory(dir, 1), /total cap of 100 MB/);
  console.log('PASS malformed/empty media, hidden entries, symlinks and both size limits are refused');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
