#!/usr/bin/env node
// CI: turns Vitest / Playwright JSON reports into GitHub annotations so results
// are readable through the public API (check-run annotations) without log
// access. One ::notice summary per report, one ::error per failed test (the
// first 8; GitHub keeps 10 error annotations per step).
//
// Usage: node scripts/ci/annotate-test-results.mjs <label> <report.json> [--playwright]
// Exit code is always 0: the test step itself decides pass/fail. A missing
// report is itself reported as an error annotation.
import { existsSync, readFileSync } from 'node:fs';
import { encodeAnnotation, encodeProperty } from './annotations.mjs';

const [label, file, mode] = process.argv.slice(2);
const MAX_ERRORS = 8;
const short = (text) => encodeAnnotation(String(text ?? '').replace(/\u001b\[[0-9;]*m/g, '').slice(0, 900));

if (!label || !file) {
  console.log('::error title=annotate-test-results::usage: <label> <report.json> [--playwright]');
  process.exit(0);
}
if (!existsSync(file)) {
  console.log(`::error title=${encodeProperty(`${label} results`)}::no report at ${encodeAnnotation(file)} (tests did not run or crashed before reporting)`);
  process.exit(0);
}

const report = JSON.parse(readFileSync(file, 'utf8'));
const failures = [];
let summary;

if (mode === '--playwright') {
  const s = report.stats ?? {};
  const walk = (suite, path) => {
    for (const spec of suite.specs ?? []) {
      if (!spec.ok) {
        const result = spec.tests?.flatMap((t) => t.results ?? []).find((r) => r.status !== 'passed' && r.status !== 'skipped');
        failures.push({ name: [...path, spec.title].join(' > '), message: result?.error?.message ?? result?.status });
      }
    }
    for (const child of suite.suites ?? []) walk(child, [...path, child.title]);
  };
  for (const suite of report.suites ?? []) walk(suite, [suite.title]);
  summary = `passed ${s.expected ?? 0}, failed ${s.unexpected ?? 0}, flaky ${s.flaky ?? 0}, skipped ${s.skipped ?? 0}`;
  if ((report.errors ?? []).length > 0) {
    failures.push(...report.errors.map((e) => ({ name: 'global error', message: e.message })));
  }
} else {
  for (const fileResult of report.testResults ?? []) {
    const failed = (fileResult.assertionResults ?? []).filter((a) => a.status === 'failed');
    for (const a of failed) failures.push({ name: a.fullName ?? a.title, message: a.failureMessages?.[0] });
    if (fileResult.status === 'failed' && failed.length === 0) {
      failures.push({ name: fileResult.name?.split('/crm/').pop(), message: fileResult.message || 'suite failed to run' });
    }
  }
  summary = `suites ${report.numTotalTestSuites ?? '?'}, tests ${report.numTotalTests ?? 0}: passed ${report.numPassedTests ?? 0}, failed ${report.numFailedTests ?? 0}, skipped ${(report.numPendingTests ?? 0) + (report.numTodoTests ?? 0)}`;
}

console.log(`::notice title=${encodeProperty(`${label} results`)}::${encodeAnnotation(summary)}`);
for (const f of failures.slice(0, MAX_ERRORS)) {
  console.log(`::error title=${encodeProperty(`${label} failed: ${String(f.name).slice(0, 180)}`)}::${short(f.message)}`);
}
if (failures.length > MAX_ERRORS) {
  console.log(`::error title=${encodeProperty(`${label} failures`)}::${failures.length - MAX_ERRORS} more failures not annotated`);
}
