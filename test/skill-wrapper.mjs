import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skill = fs.readFileSync(path.join(root, '.opencode/skills/issue-orchestrator/SKILL.md'), 'utf8');

assert.equal(fs.existsSync(path.join(root, '.opencode/commands/goal.md')), false,
  'project must not override OpenCode built-in /goal with a custom slash command');
assert.match(skill, /^---\nname: issue-orchestrator\ndescription: .+\n---\n/m);
assert.match(skill, /@all-the\.rest\/issue-orchestrator/);
assert.match(skill, /issue-orchestrator goal --project <owner\/repo> --issue <number> --goal-file/);
assert.match(skill, /node \/path\/to\/issue-orchestrator\/dist\/cli\.js goal --project <owner\/repo> --issue <number> --goal-file/);
assert.match(skill, /stdout\n\(JSON for normal outcomes\) and the exit status/);
assert.doesNotMatch(skill, /\/goal\b/, 'wrapper must describe the issue-orchestrator goal CLI, not a slash command');
assert.doesNotMatch(skill, /^\d+\.\s/m, 'wrapper must not encode a workflow state machine');
assert.doesNotMatch(skill, /\b(?:gh|glab)\s+(?:api|issue|pr|auth)\b/i, 'wrapper must not invoke provider tooling directly');

console.log('thin skill-wrapper contract passed');
