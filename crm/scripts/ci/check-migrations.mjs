#!/usr/bin/env node
// CI: migration history rules (see migration-history.mjs).
// Usage (from crm/): node scripts/ci/check-migrations.mjs [--base <git ref>]
// Without --base only the current files are checked (duplicate versions,
// file names). With --base, edits, renames, deletions and out-of-order
// additions are checked against that ref (two-dot diff: on a pull request
// GitHub checks out the merge commit, so the diff is exactly the PR).
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { checkMigrationHistory } from './migration-history.mjs';

const DIR = 'supabase/migrations';
const baseIndex = process.argv.indexOf('--base');
const base = baseIndex > -1 ? process.argv[baseIndex + 1] : undefined;
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });

const files = readdirSync(DIR).filter((f) => f.endsWith('.sql'));
let baseFiles = [];
let changes = [];
if (base) {
  baseFiles = git('ls-tree', '--name-only', base, '--', `${DIR}/`)
    .split('\n')
    .filter((p) => p.endsWith('.sql'))
    .map((p) => p.split('/').pop());
  changes = git('diff', '--name-status', '-M', base, 'HEAD', '--', DIR)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t');
      return { status: parts[0], path: parts.at(-1), from: parts.length > 2 ? parts[1] : undefined };
    });
}
// Owner-approved renumbering (content unchanged), with the reason for reviewers.
const approvedRenames = JSON.parse(readFileSync(new URL('./approved-migration-renumbering.json', import.meta.url), 'utf8')).renames;

const { errors, warnings } = checkMigrationHistory({ files, baseFiles, changes, approvedRenames });
for (const w of warnings) console.log(`::warning title=migration history::${w}`);
for (const e of errors) console.log(`::error title=migration history::${e}`);
console.log(`check-migrations: ${files.length} files, ${errors.length} errors, ${warnings.length} warnings${base ? ` (base ${base})` : ''}`);
process.exitCode = errors.length ? 1 : 0;
