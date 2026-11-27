#!/usr/bin/env node
// Before an artifact upload: replaces every per-run secret value (from the
// environment, see mint-keys.mjs) with "***" in the text files of a folder.
// GitHub masks these values in the job log but not inside uploaded files, and
// artifacts of the public test copy can be downloaded by anyone signed in.
// The values are random per run and the stack is destroyed with the job; this
// keeps them out of the artifacts anyway.
//
// Usage: node scrub-artifacts.mjs <folder>
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const folder = process.argv[2];
if (!folder) {
  console.error('usage: scrub-artifacts.mjs <folder>');
  process.exit(2);
}
const NAMES = ['PLAIN_JWT_SECRET', 'PLAIN_DB_PASSWORD', 'PLAIN_SVC_DB_PASSWORD', 'PLAIN_PROBE_PASSWORD', 'PLAIN_S3_ACCESS_KEY',
  'PLAIN_S3_SECRET_KEY', 'PLAIN_ANON_KEY', 'PLAIN_SERVICE_KEY'];
const values = NAMES.map((n) => process.env[n]?.trim()).filter((v) => v && v.length >= 8);

let files = 0;
let replaced = 0;
function walk(dir) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    const info = statSync(path);
    if (info.isDirectory()) walk(path);
    else if (info.size < 50 * 1024 * 1024 && /\.(json|txt|log|tsv|md|html|xml|sql)$/i.test(entry)) {
      const text = readFileSync(path, 'utf8');
      let next = text;
      for (const v of values) next = next.split(v).join('***');
      files += 1;
      if (next !== text) {
        replaced += 1;
        writeFileSync(path, next);
      }
    }
  }
}
walk(folder);
console.log(`scrub-artifacts: ${files} text files checked, ${replaced} had a run secret replaced`);
