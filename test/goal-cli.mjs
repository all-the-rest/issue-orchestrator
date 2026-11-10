import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SQLiteStore } from '../dist/core/persistence.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-cli-'));
const bin = path.join(root, 'bin');
const home = path.join(root, 'runtime');
const config = path.join(root, 'config.jsonc');
const stateFile = path.join(root, 'github-state.json');
const ghLog = path.join(root, 'gh.log');
const labelOptIn = path.join(root, 'auto-label');
const agent = path.join(root, 'agent.mjs');
const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/cli.js');
fs.mkdirSync(bin, { recursive: true });
fs.writeFileSync(stateFile, JSON.stringify({ comments: [
  { id: 'tool-comment', body: 'tool-authored context', created_at: '2026-01-01T00:00:00Z', user: { login: 'configured-account' } },
  { id: 'human-comment', body: 'human-authored context', created_at: '2026-01-02T00:00:00Z', user: { login: 'human' } },
] }));
fs.writeFileSync(ghLog, '');

const gh = path.join(bin, 'gh');
fs.writeFileSync(gh, `#!/usr/bin/env node
const fs=require('node:fs');
const a=process.argv.slice(2); fs.appendFileSync(process.env.FAKE_GH_LOG,JSON.stringify(a)+'\\n');
const file=process.env.FAKE_GH_STATE; const s=JSON.parse(fs.readFileSync(file,'utf8'));
if(a[0]==='api'&&a[1]==='user'){process.stdout.write('configured-account\\n');process.exit(0)}
 if(a[0]==='issue'&&a[1]==='view'){
  process.stdout.write(JSON.stringify({id:'fixture-7',number:7,title:'Fixture ticket',body:'ticket body',author:{login:'human'},labels:fs.existsSync(process.env.FAKE_AUTO_LABEL)?[{name:'agent:auto-implement'}]:[],state:'OPEN',url:'https://github.com/owner/repo/issues/7',updatedAt:null}));process.exit(0)
}
if(a[0]==='api'&&a.some(x=>x==='repos/owner/repo/issues/7/comments')){process.stdout.write(JSON.stringify([s.comments]));process.exit(0)}
if(a[0]==='issue'&&a[1]==='comment'){
 const body=a[a.indexOf('--body')+1];s.comments.push({id:String(s.comments.length+1),body,created_at:new Date(Date.UTC(2026,0,1,0,0,s.comments.length)).toISOString(),user:{login:'configured-account'},html_url:'https://github.com/owner/repo/issues/7#issuecomment-'+(s.comments.length+1)});
 fs.writeFileSync(file,JSON.stringify(s));process.exit(0)
}
process.stderr.write('unexpected gh invocation\\n');process.exit(2);
`);
fs.chmodSync(gh, 0o700);

const git = path.join(bin, 'git');
fs.writeFileSync(git, `#!/usr/bin/env node
const a=process.argv.slice(2);while(a[0]==='-c')a.splice(0,2);
if(a[0]==='rev-parse'&&a[1]==='--show-toplevel'){process.stdout.write(process.cwd()+'\\n');process.exit(0)}
if(a[0]==='config'&&a[1]==='--get'&&a[2]==='remote.origin.url'){process.stdout.write('https://github.com/owner/repo.git\\n');process.exit(0)}
if(a[0]==='remote'&&a[1]==='get-url'&&a[2]==='--push'&&a[3]==='origin'){process.stdout.write('https://github.com/owner/repo.git\\n');process.exit(0)}
if(a[0]==='ls-remote'&&a[1]==='--get-url'){process.stdout.write(a[2]+'\\n');process.exit(0)}
if(a[0]==='config'&&a[1]==='--null'&&a[2]==='--get-regexp')process.exit(1);
process.stderr.write('unexpected git invocation: '+a.join(' ')+'\\n');process.exit(2);
`);
fs.chmodSync(git, 0o700);

const exactGoal = ['  Preserve these exact final criteria.', 'Do not trim this text.  '].join('\n');
fs.writeFileSync(agent, `let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const q=JSON.parse(s);if(q.operation==='run'){const i=q.input;if(!i||i.kind!=='initial'||i.mode!=='auto-implement'||i.mergePolicy!=='manual'||i.finalAcceptanceCriteria!==${JSON.stringify(exactGoal)}||i.ticket?.title!=='Fixture ticket'||i.ticket?.body!=='ticket body'||!Array.isArray(i.updates)||i.updates.length!==1||i.updates[0].body!=='human-authored context'||!q.system_prompt||q.system_prompt.includes('Preserve these exact final criteria.'))process.exit(4)}const result={status:'DONE',summary:'fixture completed',changed_files:[],commands:[],acceptance:[],blocked_reason:null,evidence_dir:null,verdict:'DONE',references:[{kind:'pull_request',url:'https://github.com/owner/repo/pull/42'},{kind:'checks',url:'https://github.com/owner/repo/pull/42/checks'}]};process.stdout.write(JSON.stringify({protocol:q.protocol,...(q.operation==='createSession'?{session_id:'fixture-session',status:'CREATED'}:{result})}));});`);

const dod = { commands: { build: null, test: null, lint: null, typecheck: null, security: null },
  required_checks: ['CI'], evidence_class: 'cli', acceptance_source: 'issue_body' };
fs.writeFileSync(config, JSON.stringify({ model: 'openai/test-model', accounts: ['repo-account', 'configured-account'],
  repos: { 'owner/repo': { account: 'repo-account', tracker_account: 'configured-account', tracker: 'github', agent_runner: 'command',
    command_runner: { executable: process.execPath, args: [agent], timeout_ms: 10000 }, auto_merge: false, dod } } }));

function run(args, input) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', env: {
    ...process.env, PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`, ISSUE_ORCHESTRATOR_HOME: home,
    ISSUE_ORCHESTRATOR_CONFIG: config, FAKE_GH_STATE: stateFile, FAKE_GH_LOG: ghLog, FAKE_AUTO_LABEL: labelOptIn,
  }, ...(input === undefined ? {} : { input }) });
}

try {
  const goal = path.join(root, 'goal.txt');
  const exact = exactGoal;
  fs.writeFileSync(goal, exact, { mode: 0o600 });
  fs.chmodSync(goal, 0o600);
  const initial = run(['goal', '--project', 'owner/repo', '--issue', '7', '--goal-file', goal]);
  assert.equal(initial.status, 0, initial.stderr || initial.stdout);
  const outcome = JSON.parse(initial.stdout);
  assert.equal(outcome.state, 'review');
  assert.equal(outcome.sessionId, null, 'human-directed ticket must not create an agent session');
  const comments = JSON.parse(fs.readFileSync(stateFile, 'utf8')).comments;
  assert.equal(comments.length, 4, 'two fixture comments plus one started and one terminal status are present');
  assert.match(comments[2].body, /human-directed/);
  assert.match(comments[3].body, /outcome REVIEW/);
  assert.match(comments[3].body, /add the configured auto-implementation label/);
  const db = new SQLiteStore(path.join(home, 'orchestrator.sqlite3'));
  const saved = db.rows('SELECT goal_json,state_json FROM ticket_handoffs')[0];
  assert.equal(JSON.parse(saved.goal_json), exact);
  assert.equal(JSON.parse(saved.state_json).terminal, true);
  assert.equal(Number(db.rows("SELECT COUNT(*) AS count FROM agent_sessions")[0].count), 0);
  assert.equal(Number(db.rows("SELECT COUNT(*) AS count FROM jobs WHERE stage='ticket-handoff'")[0].count), 0);
  db.close();

  const logBeforeRepeat = fs.readFileSync(ghLog, 'utf8');
  const repeated = run(['goal', '--project', 'owner/repo', '--issue', '7', '--goal-file', goal]);
  assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout);
  assert.equal(JSON.parse(repeated.stdout).state, 'review');
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).comments.length, 4, 'repeat is idempotent');
  assert.notEqual(fs.readFileSync(ghLog, 'utf8'), logBeforeRepeat, 'repeat rereads the configured GitHub ticket');

  const publicFile = path.join(root, 'public-goal.txt');
  fs.writeFileSync(publicFile, 'unsafe goal', { mode: 0o644 });
  fs.chmodSync(publicFile, 0o644);
  const logBeforeReject = fs.readFileSync(ghLog, 'utf8');
  const rejected = run(['goal', '--project', 'owner/repo', '--issue', '7', '--goal-file', publicFile]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /owned private regular file/);
  assert.equal(fs.readFileSync(ghLog, 'utf8'), logBeforeReject, 'unsafe goal file is rejected before GitHub calls');

  for (const [name, content] of [
    ['secret-goal.txt', 'Do not publish ghp_12345678901234567890123456789'],
    ['oversize-goal.txt', 'x'.repeat(32 * 1024 + 1)],
  ]) {
    const invalid = path.join(root, name);
    fs.writeFileSync(invalid, content, { mode: 0o600 }); fs.chmodSync(invalid, 0o600);
    const before = fs.readFileSync(ghLog, 'utf8');
    const result = run(['goal', '--project', 'owner/repo', '--issue', '7', '--goal-file', invalid]);
    assert.notEqual(result.status, 0, `${name} must be refused`);
    assert.equal(fs.readFileSync(ghLog, 'utf8'), before, `${name} must be refused before GitHub calls`);
  }
  const symlink = path.join(root, 'linked-goal.txt');
  fs.symlinkSync(goal, symlink);
  const beforeSymlink = fs.readFileSync(ghLog, 'utf8');
  assert.notEqual(run(['goal', '--project', 'owner/repo', '--issue', '7', '--goal-file', symlink]).status, 0);
  assert.equal(fs.readFileSync(ghLog, 'utf8'), beforeSymlink, 'symlink goal files fail before GitHub calls');

  const stdinGoal = ['Exact stdin acceptance.', 'Second criterion.'].join('\n');
  const fromStdin = run(['goal', '--project', 'owner/repo', '--issue', '7', '--goal-file', '-'], stdinGoal);
  assert.equal(fromStdin.status, 0, fromStdin.stderr || fromStdin.stdout);
  const verify = new SQLiteStore(path.join(home, 'orchestrator.sqlite3'));
  assert.ok(verify.rows('SELECT 1 FROM ticket_handoffs WHERE goal_json=?', JSON.stringify(stdinGoal)).length,
    'stdin goal is persisted byte-for-byte without appearing in process arguments');
  fs.writeFileSync(labelOptIn, 'yes');
  const auto = run(['goal', '--project', 'owner/repo', '--issue', '7', '--goal-file', goal]);
  assert.equal(auto.status, 0, auto.stderr || auto.stdout);
  assert.equal(JSON.parse(auto.stdout).state, 'done');
  const session = verify.rows("SELECT runner_name,status FROM agent_sessions WHERE role='builder' ORDER BY id DESC LIMIT 1")[0];
  assert.equal(session.runner_name, 'command', 'goal dispatch uses the configured command runner');
  assert.equal(session.status, 'DONE', 'the configured command actually ran and returned its validated result');
  const finalComment = JSON.parse(fs.readFileSync(stateFile, 'utf8')).comments.at(-1).body;
  assert.match(finalComment, /Agent-provided links \(not verified by this bridge\)/);
  assert.match(finalComment, /https:\/\/github\.com\/owner\/repo\/pull\/42/);
  assert.match(finalComment, /https:\/\/github\.com\/owner\/repo\/pull\/42\/checks/);
  verify.close();
  console.log('goal CLI persists exact private AC, gates human-directed tickets, and dispatches auto-labeled tickets through the configured command runner');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
