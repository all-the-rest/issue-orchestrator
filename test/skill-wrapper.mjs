import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skill = fs.readFileSync(path.join(root, '.opencode/skills/issue-orchestrator/SKILL.md'), 'utf8');

assert.match(skill, /^---\nname: issue-orchestrator\ndescription: .+\n---\n/m);
assert.match(skill, /@all-the\.rest\/issue-orchestrator/);
assert.match(skill, /issue-orchestrator run --once/);
assert.match(skill, /--project <owner\/repo>/);
assert.match(skill, /--dry-run/);
assert.match(skill, /stdout \(JSON for normal\noutcomes\) and the exit status/);
assert.doesNotMatch(skill, /^\d+\.\s/m, 'wrapper must not encode a workflow state machine');
assert.doesNotMatch(skill, /\b(?:GitHub|GitLab|Jira|gh|glab)\b/i, 'wrapper must not implement provider logic');

console.log('thin skill-wrapper contract passed');
