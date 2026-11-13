import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SQLiteStore } from '../dist/core/persistence.js';
import { IntakePacer, intakeFailureBacksOff, runIntakeTick } from '../dist/core/commands.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-router-cli-'));
const bin = path.join(root, 'bin');
const home = path.join(root, 'runtime');
const config = path.join(root, 'config.jsonc');
const ghLog = path.join(root, 'gh.log');
const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/cli.js');
fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(path.join(root, '.git'));
fs.writeFileSync(ghLog, '');

const gh = path.join(bin, 'gh');
fs.writeFileSync(gh, `#!/usr/bin/env node
const fs=require('node:fs');
const a=process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG,JSON.stringify(a)+'\\n');
if(a[0]==='api'&&a[1]==='user'){process.stdout.write('configured-account\\n');process.exit(0)}
if(a[0]==='issue'&&a[1]==='list'){
  if(a.includes('--search')){
    process.stdout.write(JSON.stringify([
      {id:'issue-5',number:5,author:{login:'trusted'},state:'OPEN',url:'https://github.com/owner/repo/issues/5',updatedAt:'2026-01-01T00:00:00Z'}
    ]));process.exit(0)
  }
  process.stdout.write(JSON.stringify([
    {id:'issue-7',number:7,author:{login:'trusted'},state:'OPEN',url:'https://github.com/owner/repo/issues/7',updatedAt:null},
    {id:'issue-8',number:8,author:{login:'stranger'},state:'OPEN',url:'https://github.com/owner/repo/issues/8',updatedAt:null},
    {id:'issue-9',number:9,author:{login:'configured-account'},state:'OPEN',url:'https://github.com/owner/repo/issues/9',updatedAt:null},
    {id:'issue-10',number:10,author:{login:'tool-bot'},state:'OPEN',url:'https://github.com/owner/repo/issues/10',updatedAt:null},
    {id:'issue-11',number:11,author:{login:'second-trusted'},state:'OPEN',url:'https://github.com/owner/repo/issues/11',updatedAt:null}
  ]));process.exit(0)
}
if(a[0]==='issue'&&a[1]==='view'){
  const n=Number(a[2]);
  const issue={7:{author:'trusted',state:'OPEN'},9:{author:'configured-account',state:'OPEN'},
    10:{author:'tool-bot',state:'OPEN'},12:{author:'trusted',state:'CLOSED'},
    13:{author:'trusted',state:'CLOSED'},14:{author:'trusted',state:'CLOSED'},
    15:{author:'stranger',state:'CLOSED'}}[n];
  if(issue){
    process.stdout.write(JSON.stringify({number:n,author:{login:issue.author},state:issue.state,
      url:'https://github.com/owner/repo/issues/'+n}));process.exit(0)
  }
}
if(a[0]==='pr'&&a[1]==='view'){
  process.stdout.write(JSON.stringify({number:Number(a[2]),state:'MERGED',
    url:'https://github.com/owner/repo/pull/'+a[2]}));process.exit(0)
}
if(a[0]==='api'&&a.includes('--jq')&&/^repos\\/owner\\/repo\\/issues\\/[0-9]+$/.test(String(a.at(-1)))){
  const n=Number(String(a.at(-1)).split('/').pop());
  if(n===11)process.exit(1);
  process.stdout.write(JSON.stringify({title:n===5?'Activate @reisi007-jr':'No activation mention',
    body:'',updated_at:'2026-01-0'+(n%10)+'T00:00:00Z'}));process.exit(0)
}
if(a[0]==='api'){process.stdout.write('[]\\n');process.exit(0)}
process.stderr.write('unexpected gh invocation\\n');process.exit(2)
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
process.stderr.write('unexpected git invocation: '+a.join(' ')+'\\n');process.exit(2)
`);
fs.chmodSync(git, 0o700);

const dod = { commands: { build: null, test: null, lint: null, typecheck: null, security: null },
  required_checks: ['CI'], evidence_class: 'cli', acceptance_source: 'issue_body' };
const trustedAuthors = ['trusted', 'configured-account', 'tool-bot', 'second-trusted'];
const routing = { model: 'openai/test-model', accounts: ['configured-account'],
  trusted_authors: trustedAuthors, tool_authors: ['tool-bot'] };
fs.writeFileSync(config, JSON.stringify({ ...routing,
  repos: { 'owner/repo': { account: 'configured-account', tracker: 'github',
    agent_runner: 'command', command_runner: { executable: process.execPath, args: [], timeout_ms: 10000 },
    workspace: root, auto_merge: false, dod } } }));
const opencodeConfig = path.join(root, 'opencode-config.json');
fs.writeFileSync(opencodeConfig, JSON.stringify({ ...routing,
  repos: { 'owner/repo': { account: 'configured-account', tracker: 'github',
    agent_runner: 'opencode', workspace: root, auto_merge: false, dod } } }));

function run(args, extraEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', env: {
    ...process.env, PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
    ISSUE_ORCHESTRATOR_HOME: home, ISSUE_ORCHESTRATOR_CONFIG: config, FAKE_GH_LOG: ghLog,
    ...extraEnv,
  } });
}

try {
  const help = run(['help']);
  assert.equal(help.status, 0);
  for (const flag of ['--quiet-period-ms', '--intake-poll-ms', '--max-concurrency',
    '--delivery-timezone', '--delivery-window', '--delivery-cooldown-ms', '--delivery-24-7',
    '--delivery-reconfigure']) {
    assert.match(help.stdout, new RegExp(flag), `--help documents ${flag}`);
  }
  assert.match(help.stdout, /defaults: quiet 60000ms, intake 30000ms, concurrency 1,/,
    '--help states the existing scheduling defaults');
  assert.match(help.stdout, /no delivery window \(24\/7\), cooldown 0 \(disabled\)/,
    '--help states the safe delivery defaults');

  const dryRun = run(['tickets', 'poll', '--project', 'owner/repo', '--dry-run']);
  assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
  assert.deepEqual(JSON.parse(dryRun.stdout).results[0].candidates, [7, 11],
    'candidates require a trusted author and exclude the authenticated account and configured tool authors');
  const calls = fs.readFileSync(ghLog, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const listArgs = calls.find((args) => args[0] === 'issue' && args[1] === 'list');
  assert.ok(listArgs);
  assert.doesNotMatch(listArgs.at(-1), /title|body/,
    'poll selection fetches routing metadata only, not issue content');
  assert.ok(calls.every((args) => !(args[0] === 'issue' && args[1] === 'comment')),
    'dry-run performs no GitHub comment writes');
  assert.equal(fs.existsSync(path.join(home, 'orchestrator.sqlite3')), false,
    'dry-run does not create or mutate the router database');

  const beforeGoal = fs.readFileSync(ghLog, 'utf8');
  const goal = path.join(root, 'goal.txt');
  fs.writeFileSync(goal, 'exact private acceptance criteria', { mode: 0o600 });
  const unsupportedRunner = run(['goal', '--project', 'owner/repo', '--issue', '7', '--goal-file', goal]);
  assert.notEqual(unsupportedRunner.status, 0);
  assert.match(unsupportedRunner.stderr, /requires agent_runner "opencode"/);
  assert.equal(fs.readFileSync(ghLog, 'utf8'), beforeGoal,
    'ticket-agent rejects a non-OpenCode runner before GitHub calls');

  const publicGoal = path.join(root, 'public-goal.txt');
  fs.writeFileSync(publicGoal, 'unsafe goal', { mode: 0o644 });
  fs.chmodSync(publicGoal, 0o644);
  const rejected = run(['goal', '--project', 'owner/repo', '--issue', '7', '--goal-file', publicGoal]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /owned private regular file/);
  assert.equal(fs.readFileSync(ghLog, 'utf8'), beforeGoal,
    'unsafe goal files are refused before any GitHub access');

  const excludedBot = run(['goal', '--project', 'owner/repo', '--issue', '9', '--goal-file', goal,
    '--config', opencodeConfig]);
  assert.notEqual(excludedBot.status, 0);
  assert.match(excludedBot.stderr, /authenticated account or a configured tool author/,
    'goal refuses the authenticated account even when it is also listed as trusted');

  const excludedTool = run(['goal', '--project', 'owner/repo', '--issue', '10', '--goal-file', goal,
    '--config', opencodeConfig]);
  assert.notEqual(excludedTool.status, 0);
  assert.match(excludedTool.stderr, /authenticated account or a configured tool author/,
    'goal refuses configured tool authors even when they are also listed as trusted');

  const closedIssue = run(['goal', '--project', 'owner/repo', '--issue', '12', '--goal-file', goal,
    '--config', opencodeConfig]);
  assert.notEqual(closedIssue.status, 0);
  assert.match(closedIssue.stderr, /is not open/, 'goal refuses a closed issue');

  const worktrees = path.join(home, 'tickets');
  fs.mkdirSync(worktrees, { recursive: true, mode: 0o700 });
  fs.chmodSync(worktrees, 0o700);
  for (const issue of [7, 11]) {
    fs.writeFileSync(path.join(worktrees, `owner__repo-issue-${issue}`), 'not a worktree');
  }
  // A closed issue whose route-only handoff still owns a merged PR must keep
  // being discovered even though `gh issue list` only returns open issues.
  const seeded = new SQLiteStore(path.join(home, 'orchestrator.sqlite3'));
  seeded.getOrCreateTicketHandoff({
    id: createHash('sha256').update('ticket-router:owner/repo#12').digest('hex'),
    project: 'owner/repo', issue: 12,
    goalHash: createHash('sha256').update('route-only:owner/repo#12').digest('hex'),
    goal: 'Route GitHub ticket owner/repo#12',
    state: {
      ticket: { project: 'owner/repo', number: 12, title: '', body: '', author: null,
        labels: ['agent:auto-implement'], url: 'https://github.com/owner/repo/issues/12',
        state: null, updatedAt: null, mode: 'auto-implement', comments: [] },
      mergePolicy: 'manual', cursor: '1', changeCursor: null, changeState: 'MERGED',
      pullRequest: null, pendingPullRequest: null,
      retiredPullRequests: [{ number: 42, url: 'https://github.com/owner/repo/pull/42',
        cursor: JSON.stringify({ conversation: 100, review: 0, reviewComment: 0 }), cursorSeeded: true,
        state: 'MERGED', lastPolledAt: null, failures: 0 }],
      routeCursorSeeded: true, routeGoalHashes: [], workflow: 'route-only',
      sessionId: 'seeded-session', initialDispatched: true, initialProgress: 2,
      state: 'DONE', terminal: true,
      statusKeys: { started: '11111111-1111-1111-1111-111111111111', finished: '22222222-2222-2222-2222-222222222222' },
      statusIds: {}, turns: [], pendingTurn: null,
      result: { status: 'DONE', summary: 'seeded', changed_files: [], commands: [], acceptance: [],
        blocked_reason: null, evidence_dir: null, verdict: 'DONE' },
      summary: 'seeded', finalStatusBody: '', failureStatus: null,
      deferredUpdates: [], deferredFields: [], quietUntil: null,
    },
  });
  seeded.close();
  const seededAgain = new SQLiteStore(path.join(home, 'orchestrator.sqlite3'));
  const routeState = (issue, { retired = false, dispatched = true, terminal = true } = {}) => ({
    ticket: { project: 'owner/repo', number: issue, title: '', body: '', author: null,
      labels: ['agent:auto-implement'], url: `https://github.com/owner/repo/issues/${issue}`,
      state: null, updatedAt: null, mode: 'auto-implement', comments: [] },
    mergePolicy: 'manual', cursor: '1', changeCursor: null,
    changeState: retired ? 'MERGED' : 'OPEN', changeCursorSeeded: true,
    pullRequest: null, pendingPullRequest: null,
    retiredPullRequests: retired ? [{ number: 500 + issue,
      url: `https://github.com/owner/repo/pull/${500 + issue}`,
      cursor: JSON.stringify({ conversation: 0, review: 0, reviewComment: 0 }), cursorSeeded: true,
      state: 'MERGED', lastPolledAt: null, failures: 0 }] : [],
    routeCursorSeeded: true, routeGoalHashes: [], workflow: 'route-only',
    sessionId: dispatched ? 'seeded-session' : null,
    initialDispatched: dispatched, initialProgress: dispatched ? 2 : 0,
    state: 'DONE', terminal,
    statusKeys: { started: '11111111-1111-1111-1111-111111111111', finished: '22222222-2222-2222-2222-222222222222' },
    statusIds: {}, turns: [], pendingTurn: null,
    result: { status: 'DONE', summary: 'seeded', changed_files: [], commands: [], acceptance: [],
      blocked_reason: null, evidence_dir: null, verdict: 'DONE' },
    summary: 'seeded', finalStatusBody: '', failureStatus: null,
    deferredUpdates: [], deferredFields: [], quietUntil: null,
  });
  const addRoute = (issue, options) => seededAgain.getOrCreateTicketHandoff({
    id: String(issue).padStart(2, '0').repeat(32).slice(0, 64),
    project: 'owner/repo', issue,
    goalHash: createHash('sha256').update(`route-only:owner/repo#${issue}`).digest('hex'),
    goal: `Route GitHub ticket owner/repo#${issue}`,
    state: routeState(issue, options),
  });
  addRoute(13, { retired: false, dispatched: false, terminal: false });
  addRoute(14, { retired: true, dispatched: false });
  addRoute(15, { retired: true, dispatched: true });
  addRoute(16, { retired: true, dispatched: true });
  seededAgain.close();
  const isolated = run(['tickets', 'poll', '--project', 'owner/repo', '--config', opencodeConfig]);
  assert.equal(isolated.status, 1);
  const isolatedOutput = JSON.parse(isolated.stdout);
  assert.equal(isolatedOutput.intake.base_interval_ms, 30_000,
    'poll output surfaces the throttled intake cadence');
  assert.deepEqual(isolatedOutput.intake.errors, []);
  const failedIssues = isolatedOutput.results
    .filter((entry) => entry.outcome === 'FAILED' || entry.state === 'failed')
    .map((entry) => entry.issue).sort((a, b) => a - b);
  assert.deepEqual(failedIssues, [7, 11],
    'a candidate error is reported for that issue without aborting the remaining candidates');
  assert.ok(isolatedOutput.results.some((entry) => entry.issue === 12 && entry.state === 'done'),
    'a closed issue with a tracked PR handoff is still discovered and polled');
  for (const issueNumber of [13, 14, 15, 16]) {
    assert.equal(isolatedOutput.results.some((entry) => entry.issue === issueNumber), false,
      `retained row ${issueNumber} must not start a task without a usable tracked association`);
  }
  assert.ok(isolatedOutput.results.some((entry) => entry.outcome === 'DEFERRED' &&
    /identity unavailable/.test(String(entry.reason))),
  'an unverifiable retained association is skipped safely and reported');
  assert.ok(isolatedOutput.results.some((entry) => entry.outcome === 'DEFERRED' &&
    /no longer trusted|first bootstrap/.test(String(entry.reason))),
  'an untrusted or never-dispatched closed association is rejected');
  const polledCalls = fs.readFileSync(ghLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(polledCalls.some((args) => args[0] === 'api' && String(args.at(-1)).includes('pulls/42/comments')),
    'post-merge PR conversations are read for a closed issue');
  assert.ok(polledCalls.every((args) => !(args[0] === 'issue' && args[1] === 'comment')),
    'the router performs no provider writes');

  const baseConfig = JSON.parse(fs.readFileSync(opencodeConfig, 'utf8'));
  const activationConfig = path.join(root, 'activation-config.json');
  fs.writeFileSync(activationConfig, JSON.stringify({ ...baseConfig,
    repos: { 'owner/repo': { ...baseConfig.repos['owner/repo'],
      tickets: { activation_mention: 'reisi007-jr' } } } }));

  // The saturated listing window contains only unmentioned issues. The
  // bounded mention search finds an older issue, while an activation-read
  // failure on another issue is reported without hiding that candidate.
  const activationDryRun = run(['tickets', 'poll', '--project', 'owner/repo', '--dry-run',
    '--max', '5', '--config', activationConfig]);
  assert.equal(activationDryRun.status, 0, activationDryRun.stderr || activationDryRun.stdout);
  const activationDryOutput = JSON.parse(activationDryRun.stdout);
  assert.deepEqual(activationDryOutput.results.find((entry) => entry.outcome === 'DRY_RUN').candidates, [5],
    'mention search discovers a late activation older than the bounded listing window');
  assert.ok(activationDryOutput.results.some((entry) => entry.outcome === 'DEFERRED' &&
    entry.issue === 11 && /activation mention check unavailable/.test(entry.reason)),
  'an activation failure is isolated to its issue even during discovery');
  const activationCalls = fs.readFileSync(ghLog, 'utf8').trim().split(/\r?\n/).filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(activationCalls.some((args) => args[0] === 'issue' && args[1] === 'list' &&
    args.includes('--search') && args.includes('is:issue mentions:reisi007-jr')),
  'the fallback uses the bounded GitHub mention search');

  // An activation-read failure for a new candidate must not abort the poll
  // before the retained route-only association (closed issue 12) drains.
  const activationDrain = run(['tickets', 'poll', '--project', 'owner/repo', '--config', activationConfig]);
  assert.equal(activationDrain.status, 1);
  const activationDrainOutput = JSON.parse(activationDrain.stdout);
  assert.ok(activationDrainOutput.results.some((entry) => entry.issue === 12 && entry.state === 'done'),
    'a retained association still drains after another issue activation check fails');
  assert.ok(activationDrainOutput.results.some((entry) => entry.outcome === 'DEFERRED' &&
    entry.issue === 11 && /activation mention check unavailable/.test(entry.reason)),
  'the per-issue activation failure remains visible in the poll result');

  // A per-issue activation failure is a diagnostic: the shared intake cadence
  // stays at its base interval rather than backing off every session. Every
  // other intake fault (listing, provider search, retained association, a task)
  // is shared and must back off. Exercise the same pacing state machine the
  // loop uses, including recovery and the eight-interval ceiling.
  const backingOff = run(['tickets', 'poll', '--project', 'owner/repo', '--config', activationConfig]);
  assert.equal(backingOff.status, 0, backingOff.stderr || backingOff.stdout);
  const backingOffOutput = JSON.parse(backingOff.stdout);
  assert.ok(backingOffOutput.results.some((entry) => entry.outcome === 'DEFERRED' &&
    /activation check backing off/.test(String(entry.reason))),
  'a per-issue failure is retried only after its local delay, not every poll');
  assert.equal(intakeFailureBacksOff('issue'), false,
    'only a per-issue activation failure stays local');
  for (const kind of ['project', 'search', 'association', 'task', 'unexpected']) {
    assert.equal(intakeFailureBacksOff(kind), true,
      `${kind} failures slow the shared intake cadence`);
  }
  const pacer = new IntakePacer(30_000);
  assert.equal(pacer.record(true), 30_000,
    'a pass that only recorded per-issue activation diagnostics keeps the base cadence');
  assert.equal(pacer.backoffMs, 0);
  assert.equal(pacer.record(true), 30_000);
  assert.equal(pacer.record(false), 60_000,
    'a shared intake fault doubles the next intake delay');
  assert.equal(pacer.record(false), 120_000);
  assert.equal(pacer.record(false), 240_000);
  assert.equal(pacer.record(false), 240_000, 'the intake backoff is capped at eight base intervals');
  assert.equal(pacer.record(true), 30_000, 'a healthy pass resets the shared cadence immediately');
  assert.equal(pacer.backoffMs, 0);

  // Every valid intake_poll_ms up to one hour must be usable as the base
  // interval: the five-minute backoff ceiling may never fall below the base.
  const tenMinutePacer = new IntakePacer(600_000);
  assert.equal(tenMinutePacer.nextDelayMs, 600_000,
    'a ten-minute intake cadence is accepted and keeps its base interval');
  assert.equal(tenMinutePacer.record(false), 600_000,
    'the backoff ceiling never drops below a base interval above five minutes');
  assert.equal(tenMinutePacer.record(false), 600_000);
  const hourPacer = new IntakePacer(3_600_000);
  assert.equal(hourPacer.nextDelayMs, 3_600_000,
    'the maximum configurable intake cadence is valid pacing input');
  assert.equal(hourPacer.record(false), 3_600_000);
  assert.throws(() => new IntakePacer(30_000, 29_999), /invalid intake pacing interval/,
    'an explicit ceiling below the base interval is still rejected');

  // Exercise the real intake tick (the function the poll loop schedules), not
  // only the classifier: a per-issue activation failure keeps the pace, while
  // listing, search, association and per-task failures force a global backoff.
  const tickDir = fs.mkdtempSync(path.join(root, 'intake-tick-'));
  const tickStore = new SQLiteStore(path.join(tickDir, 'tick.sqlite3'));
  const tickContext = (project) => ({ project, rc: { project, trusted_authors: ['human'], tickets: {} },
    base: tickDir, store: tickStore, runner: null, routingPort: {}, delivery: null });
  const noDiscovery = () => ({ candidates: [], failures: [], searchFailure: null,
    searchBudgetRetryAt: null, deferred: [], budgetDenied: [], budgetRetryAt: null,
    retrying: [], incomplete: [], activationChecks: 0 });
  const tickErrors = [];
  const tickOptions = (overrides = {}) => ({
    cfg: {}, max: 10, contexts: [tickContext('owner/alpha'), tickContext('owner/beta')],
    knownTasks: new Set(), tasks: [], noteError: (error, project, issue) =>
      tickErrors.push({ project, issue, message: String(error?.message ?? error) }),
    runTask: async () => true, select: async () => [],
    discover: async (_cfg, rc) => noDiscovery(rc.project),
    appendKnown: async () => ({ added: 0, unverified: 0, rejected: 0, truncated: false }),
    ...overrides,
  });
  try {
    tickErrors.length = 0;
    const localOnly = await runIntakeTick(tickOptions({
      discover: async (_cfg, rc) => ({ ...noDiscovery(rc.project),
        failures: rc.project === 'owner/alpha' ? [{ issue: 7, error: 'activation read failed' }] : [],
        budgetDenied: rc.project === 'owner/beta' ? [8] : [] }),
    }));
    assert.equal(localOnly, true, 'per-issue activation and budget deferrals are not global faults');
    assert.equal(new IntakePacer(30_000).record(localOnly), 30_000,
      'the tick result keeps the shared cadence at its base interval');
    assert.ok(tickErrors.some((entry) => entry.project === 'owner/alpha' && entry.issue === 7));

    tickErrors.length = 0;
    const listingFailed = await runIntakeTick(tickOptions({
      select: async (project) => {
        if (project === 'owner/alpha') throw new Error('listing unavailable');
        return [];
      },
    }));
    assert.equal(listingFailed, false, 'a listing failure is a shared intake fault');
    assert.equal(new IntakePacer(30_000).record(listingFailed), 60_000,
      'a listing failure doubles the shared intake delay');
    assert.ok(tickErrors.some((entry) => entry.project === 'owner/alpha'));

    tickErrors.length = 0;
    const searchFailed = await runIntakeTick(tickOptions({
      discover: async (_cfg, rc) => ({ ...noDiscovery(rc.project),
        searchFailure: rc.project === 'owner/beta' ? 'search unavailable' : null }),
    }));
    assert.equal(searchFailed, false, 'a provider search failure is a shared intake fault');

    tickErrors.length = 0;
    const associationFailed = await runIntakeTick(tickOptions({
      appendKnown: async (_cfg, context) => {
        if (context.project === 'owner/beta') throw new Error('association read failed');
        return { added: 0, unverified: 0, rejected: 0, truncated: false };
      },
    }));
    assert.equal(associationFailed, false, 'a retained-association failure is a shared intake fault');

    tickErrors.length = 0;
    const intakeTask = { ...tickContext('owner/alpha'), issue: 12, ticketUrl: '',
      activationUpdatedAt: null, activationPreverified: true, retryBlocked: false };
    const taskFailed = await runIntakeTick(tickOptions({
      tasks: [intakeTask], runTask: async () => false,
    }));
    assert.equal(taskFailed, false, 'a failed intake task is a shared intake fault');

    // The tick uses the durable rotation, so the second context is discovered
    // first after the first project consumed budget on an earlier poll.
    tickStore.consumeTicketActivationBudget(1, {
      project: 'owner/alpha', limit: 10, windowMs: 60_000, now: Date.now() });
    const discoveryOrder = [];
    await runIntakeTick(tickOptions({
      contexts: [tickContext('owner/alpha'), tickContext('owner/beta')],
      discover: async (_cfg, rc) => {
        discoveryOrder.push(rc.project);
        return noDiscovery(rc.project);
      },
    }));
    assert.deepEqual(discoveryOrder, ['owner/beta', 'owner/alpha'],
      'the actual tick discovers the least recently served project first');
  } finally {
    tickStore.close();
    fs.rmSync(tickDir, { recursive: true, force: true });
  }
  // The poller report surfaces the pacing configuration the loop uses.
  assert.equal(backingOffOutput.intake.base_interval_ms, 30_000);
  assert.ok(backingOffOutput.results.some((entry) => entry.issue === 12 && entry.state === 'done'),
    'the retained association still drains while another issue is backing off');

  // An exhausted pair of shared budgets must skip the mention search and every
  // activation read without a provider request, and report the deferral
  // instead of entering a retry storm. Search has its own rolling budget, so
  // both have to be saturated to model an exhausted external quota.
  const exhaustedHome = path.join(root, 'runtime-exhausted');
  fs.mkdirSync(exhaustedHome, { recursive: true, mode: 0o700 });
  fs.chmodSync(exhaustedHome, 0o700);
  const exhaustedStore = new SQLiteStore(path.join(exhaustedHome, 'orchestrator.sqlite3'));
  // Pin the refill anchor slightly in the future so no wall-clock refill can
  // occur during this (subprocess) poll. The budget is empty either way; the
  // future anchor only removes timing flakiness from the assertion that no
  // provider request is made (the bucket treats a clock behind the anchor as
  // zero elapsed and fails closed).
  exhaustedStore.db.prepare('INSERT INTO ticket_api_budget(singleton,tokens,updated_ms) VALUES (1,0,?)')
    .run(Date.now() + 60_000);
  exhaustedStore.db.prepare('INSERT INTO ticket_search_budget(granted_at_ms,cost,project) VALUES (?,?,?)')
    .run(Date.now() + 60_000, 30, 'owner/repo');
  exhaustedStore.close();
  const exhaustedBefore = fs.readFileSync(ghLog, 'utf8').length;
  const exhausted = run(['tickets', 'poll', '--project', 'owner/repo', '--config', activationConfig,
    '--max', '5'], { ISSUE_ORCHESTRATOR_HOME: exhaustedHome });
  assert.equal(exhausted.status, 0, exhausted.stderr || exhausted.stdout);
  const exhaustedOutput = JSON.parse(exhausted.stdout);
  const exhaustedCalls = fs.readFileSync(ghLog, 'utf8').slice(exhaustedBefore)
    .trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(exhaustedCalls.every((args) => !args.includes('--search')),
    'an exhausted budget skips the bounded mention search without an API call');
  assert.ok(exhaustedCalls.every((args) => !(args[0] === 'api' &&
    /repos\/owner\/repo\/issues\/[0-9]+($|\/comments)/.test(String(args.at(-1))))),
  'an exhausted budget performs no activation issue or comment read');
  const exhaustedDeferral = exhaustedOutput.results.find((entry) => entry.outcome === 'DEFERRED' &&
    /shared activation API budget exhausted/.test(String(entry.reason)));
  assert.ok(exhaustedDeferral, 'the poll reports the shared budget deferral');
  assert.ok(exhaustedDeferral.retry_at, 'the deferral exposes when reservations resume');
  assert.ok(exhaustedOutput.results.filter((entry) => entry.outcome === 'DEFERRED' &&
    /activation mention search deferred by the shared API budget/.test(String(entry.reason))).length === 1,
  'the skipped mention search is reported once without a failure');

  const quietConfig = path.join(root, 'quiet-config.json');
  fs.writeFileSync(quietConfig, JSON.stringify({ ...baseConfig,
    tickets: { max_concurrency: 2, quiet_period_ms: 5000 } }));
  const configured = run(['tickets', 'poll', '--project', 'owner/repo', '--dry-run', '--config', quietConfig]);
  assert.equal(configured.status, 0, configured.stderr || configured.stdout);

  // A configured window is surfaced by dry-run, and one invocation can override
  // it without changing the config file.
  const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const closedDay = dayNames[(new Date().getUTCDay() + 3) % 7];
  const deliveryConfig = path.join(root, 'delivery-config.json');
  fs.writeFileSync(deliveryConfig, JSON.stringify({ ...baseConfig,
    tickets: { quiet_period_ms: 0, delivery: {
      timezone: 'UTC',
      windows: [{ days: [closedDay], start: '00:00', end: '23:59' }],
      cooldown_ms: 0,
    } } }));
  const closedDryRun = run(['tickets', 'poll', '--project', 'owner/repo', '--dry-run', '--config', deliveryConfig]);
  assert.equal(closedDryRun.status, 0, closedDryRun.stderr || closedDryRun.stdout);
  const closedDelivery = JSON.parse(closedDryRun.stdout).results[0].delivery;
  assert.equal(closedDelivery.active, false, 'a window on another weekday is closed');
  assert.match(closedDelivery.schedule, /^UTC: /);
  const openDryRun = run(['tickets', 'poll', '--project', 'owner/repo', '--dry-run',
    '--config', deliveryConfig, '--delivery-24-7']);
  assert.equal(openDryRun.status, 0, openDryRun.stderr || openDryRun.stdout);
  assert.equal(JSON.parse(openDryRun.stdout).results[0].delivery.active, true,
    '--delivery-24-7 overrides configured windows for this invocation');
  const flagWindow = run(['tickets', 'poll', '--project', 'owner/repo', '--dry-run',
    '--config', deliveryConfig, '--delivery-window', 'weekdays=01:00-04:00',
    '--delivery-timezone', 'UTC', '--delivery-cooldown-ms', '60000']);
  assert.equal(flagWindow.status, 0, flagWindow.stderr || flagWindow.stdout);
  assert.match(JSON.parse(flagWindow.stdout).results[0].delivery.schedule, /cooldown 1m/,
    'CLI window and cooldown flags replace the configured schedule');
  const schedulingFlags = run(['tickets', 'poll', '--project', 'owner/repo', '--dry-run',
    '--config', opencodeConfig, '--quiet-period-ms', '0', '--intake-poll-ms', '1500',
    '--max-concurrency', '2']);
  assert.equal(schedulingFlags.status, 0, schedulingFlags.stderr || schedulingFlags.stdout);
  assert.deepEqual(JSON.parse(schedulingFlags.stdout).results[0].scheduling,
    { quiet_period_ms: 0, intake_poll_ms: 1500, max_concurrency: 2 },
    'CLI flags override the existing quiet/cap/intake settings for one poll');
  for (const [flag, value, pattern] of [
    ['--quiet-period-ms', '3600001', /quiet-period-ms must be an integer/],
    ['--intake-poll-ms', '999', /intake-poll-ms must be an integer/],
    ['--max-concurrency', '0', /max-concurrency must be an integer/],
  ]) {
    const rejected = run(['tickets', 'poll', '--project', 'owner/repo', '--dry-run',
      '--config', opencodeConfig, flag, value]);
    assert.notEqual(rejected.status, 0, flag);
    assert.match(rejected.stderr, pattern, flag);
  }
  for (const [args, pattern] of [
    [['--delivery-window', 'weekdays=1:00-4:00', '--delivery-timezone', 'UTC'], /HH:MM/],
    [['--delivery-24-7', '--delivery-window', 'weekdays=01:00-04:00'], /mutually exclusive/],
    [['--delivery-cooldown-ms', '-1'], /non-negative integer|integer from 0/],
    [['--delivery-timezone', 'Mars/Olympus'], /not a supported IANA/],
  ]) {
    const rejectedFlag = run(['tickets', 'poll', '--project', 'owner/repo', '--dry-run',
      '--config', deliveryConfig, ...args]);
    assert.notEqual(rejectedFlag.status, 0, args.join(' '));
    assert.match(rejectedFlag.stderr, pattern, args.join(' '));
  }
  const missingZone = run(['tickets', 'poll', '--project', 'owner/repo', '--dry-run',
    '--config', opencodeConfig, '--delivery-window', 'weekdays=01:00-04:00']);
  assert.notEqual(missingZone.status, 0);
  assert.match(missingZone.stderr, /timezone is required/,
    'a window flag without any explicit zone is rejected');
  const invalidDelivery = path.join(root, 'invalid-delivery.json');
  fs.writeFileSync(invalidDelivery, JSON.stringify({ ...baseConfig,
    tickets: { delivery: { timezone: 'UTC', windows: [{ days: ['funday'], start: '01:00', end: '02:00' }] } } }));
  const rejectedDelivery = run(['tickets', 'poll', '--project', 'owner/repo', '--dry-run', '--config', invalidDelivery]);
  assert.notEqual(rejectedDelivery.status, 0);
  assert.match(rejectedDelivery.stderr, /unknown day/);

  // A closed window is a successful poll that defers every task without
  // starting an agent or allocating a worktree; the output reports the schedule.
  const closedPoll = run(['tickets', 'poll', '--project', 'owner/repo', '--config', deliveryConfig]);
  assert.equal(closedPoll.status, 0, closedPoll.stderr || closedPoll.stdout);
  const closedOutput = JSON.parse(closedPoll.stdout);
  assert.equal(closedOutput.delivery[0].active, false);
  assert.ok(closedOutput.results.filter((entry) => typeof entry.issue === 'number')
    .every((entry) => entry.state === 'deferred' && entry.reason === 'delivery-window'),
  'outside the window every task is deferred, never failed or dispatched');
  assert.ok(closedOutput.delivery[0].retry_at, 'the poll reports the next delivery opportunity');
  assert.ok(closedOutput.intake, 'intake is scheduled even with quiet_period_ms=0');

  // A changed global cooldown is adopted only through the explicit transition;
  // the durable last-start anchor is preserved and stale pollers fail closed.
  const reconfigured = run(['tickets', 'poll', '--project', 'owner/repo', '--config', deliveryConfig,
    '--delivery-cooldown-ms', '60000', '--delivery-reconfigure']);
  assert.equal(reconfigured.status, 0, reconfigured.stderr || reconfigured.stdout);
  const reconfiguration = JSON.parse(reconfigured.stdout).delivery_reconfiguration;
  assert.equal(reconfiguration.cooldown_ms, 60_000);
  assert.equal(reconfiguration.previous_cooldown_ms, 0);
  assert.equal(reconfiguration.changed, true);
  // The report echoes the preserved anchor; it is null only on a fresh database.
  if (reconfiguration.last_started_at === null) {
    assert.equal(reconfiguration.next_allowed_at, null);
  } else {
    assert.equal(Date.parse(reconfiguration.next_allowed_at) - Date.parse(reconfiguration.last_started_at), 60_000,
      'the transition reports the immediately effective boundary from the preserved anchor');
  }
  const stalePoller = run(['tickets', 'poll', '--project', 'owner/repo', '--config', deliveryConfig]);
  assert.notEqual(stalePoller.status, 0);
  assert.match(stalePoller.stderr, /must be identical/,
    'a poller still using the old cooldown fails closed');
  const reconfiguredAgain = run(['tickets', 'poll', '--project', 'owner/repo', '--config', deliveryConfig,
    '--delivery-cooldown-ms', '60000', '--delivery-reconfigure']);
  assert.equal(reconfiguredAgain.status, 0, reconfiguredAgain.stderr || reconfiguredAgain.stdout);
  assert.equal(JSON.parse(reconfiguredAgain.stdout).delivery_reconfiguration.changed, false,
    'reapplying the same cooldown is idempotent');
  const dryReconfigure = run(['tickets', 'poll', '--project', 'owner/repo', '--config', deliveryConfig,
    '--delivery-cooldown-ms', '60000', '--delivery-reconfigure', '--dry-run']);
  assert.notEqual(dryReconfigure.status, 0);
  assert.match(dryReconfigure.stderr, /cannot be combined with --dry-run/);

  const invalidGlobal = path.join(root, 'invalid-global.json');
  fs.writeFileSync(invalidGlobal, JSON.stringify({ ...baseConfig,
    tickets: { max_concurrency: 0, quiet_period_ms: 60000 } }));
  const rejectedGlobal = run(['tickets', 'poll', '--project', 'owner/repo', '--dry-run', '--config', invalidGlobal]);
  assert.notEqual(rejectedGlobal.status, 0);
  assert.match(rejectedGlobal.stderr, /"tickets\.max_concurrency" must be a positive integer/);
  const invalidRepo = path.join(root, 'invalid-repo.json');
  fs.writeFileSync(invalidRepo, JSON.stringify({ ...baseConfig,
    repos: { 'owner/repo': { ...baseConfig.repos['owner/repo'], tickets: { max_concurrency: 2 } } } }));
  const rejectedRepo = run(['tickets', 'poll', '--project', 'owner/repo', '--dry-run', '--config', invalidRepo]);
  assert.notEqual(rejectedRepo.status, 0);
  assert.match(rejectedRepo.stderr, /only valid at the top level/);

  console.log('ticket CLI filters authenticated and tool authors, isolates candidate errors, rejects closed goals, keeps dry-run read-only, validates ticket session limits, and requires the authenticated OpenCode ticket-agent');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
