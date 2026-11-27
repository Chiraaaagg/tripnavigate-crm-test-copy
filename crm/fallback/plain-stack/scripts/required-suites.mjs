#!/usr/bin/env node
// Checks that the named test files ran (not skipped) and passed, as the gate's
// "Required real suites ran (not skipped) and passed" step does (ci.yml).
//
//   node required-suites.mjs <vitest-report.json> <test-file> [<test-file> ...]
//
// Test files are given relative to crm/ (e.g. tests/supabase/booking.real.test.ts).
// Prints one ::notice or ::error per file; exits 1 when any is missing, skipped
// or failed.
import { readFileSync } from 'node:fs';

const [reportFile, ...files] = process.argv.slice(2);
if (!reportFile || files.length === 0) {
  console.error('usage: required-suites.mjs <vitest-report.json> <test-file>...');
  process.exit(2);
}

let report;
try {
  report = JSON.parse(readFileSync(reportFile, 'utf8'));
} catch {
  console.log(`::error title=Required plain-stack suite::${reportFile} is missing or unreadable: the suites did not run`);
  process.exit(1);
}

let failed = false;
for (const file of files) {
  const suite = (report.testResults ?? []).find((r) => String(r.name).endsWith(`/${file}`));
  const tests = suite?.assertionResults ?? [];
  const passed = tests.filter((t) => t.status === 'passed').length;
  const skipped = tests.filter((t) => t.status === 'skipped' || t.status === 'pending' || t.status === 'todo').length;
  if (tests.length === 0 || passed !== tests.length) {
    console.log(`::error title=Required plain-stack suite::${file}: ${passed}/${tests.length} passed, ${skipped} skipped (missing, skipped or failed)`);
    failed = true;
  } else {
    console.log(`::notice title=Required plain-stack suite::${file}: ${passed}/${tests.length} passed`);
  }
}
process.exit(failed ? 1 : 0);
