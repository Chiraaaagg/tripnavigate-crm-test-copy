#!/usr/bin/env node
// Report job of .github/workflows/fallback-plain-stack.yml (contract file 12,
// sections 3.6, 5.1 and 5.2). Reads the artifacts of the other jobs and writes
//   <out>/gap-report.json   every gap row with its evidence, fingerprint and
//                           capture differences, suite counts, acceptance checks
//   $GITHUB_STEP_SUMMARY    the same in short Markdown
// Usage: node build-gap-report.mjs <artifacts-dir> <out-dir>
// Missing inputs are reported as missing, never as a pass.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [artifacts, outDir] = process.argv.slice(2);
if (!artifacts || !outDir) {
  console.error('usage: build-gap-report.mjs <artifacts-dir> <out-dir>');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

/** Finds a file by name anywhere under the artifacts folder (each artifact is its own subfolder). */
function find(name, under = artifacts) {
  if (!existsSync(under)) return null;
  for (const entry of readdirSync(under)) {
    const path = join(under, entry);
    if (statSync(path).isDirectory()) {
      const hit = find(name, path);
      if (hit) return hit;
    } else if (entry === name) return path;
  }
  return null;
}
function load(name, under) {
  const path = find(name, under ? join(artifacts, under) : artifacts);
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}
const text = (name, under) => {
  const path = find(name, under ? join(artifacts, under) : artifacts);
  return path ? readFileSync(path, 'utf8') : null;
};

const baseline = { capture: load('capture-baseline.json'), fingerprint: load('fingerprint.json', 'plain-baseline') };
const plain = {
  capture: load('capture-plain.json'),
  fingerprint: load('fingerprint.json', 'plain-stack'),
  migrations: load('migrations.json', 'plain-stack'),
  timings: load('timings.json', 'plain-stack'),
  shimNotices: text('shim-notices.txt', 'plain-stack'),
  ports: text('docker-ports.txt', 'plain-stack'),
  db: load('vitest-db.json', 'plain-stack'),
  real: load('vitest-supabase.json', 'plain-stack'),
  br: load('vitest-br.json', 'plain-stack'),
  g0: load('postgrest-loop.json', 'plain-stack'),
  excluded: load('vitest-excluded.json', 'plain-stack'),
  proofTests: load('vitest-proofs.json', 'plain-stack'),
  proofs: load('proofs.json', 'plain-stack'),
  probe: load('probe.json', 'plain-stack'),
  seedLog: text('seed.log', 'plain-stack'),
  journeys: load('playwright-real-journey.json', 'plain-journeys'),
  speed: load('vitest-speed.json', 'plain-speed'),
};

// ---------------------------------------------------------------- fingerprints
function compareFingerprints(a, b) {
  if (!a || !b) return { compared: false, reason: `${a ? '' : 'baseline '}${b ? '' : 'plain '}fingerprint missing`.trim() };
  const cats = [...new Set([...Object.keys(a.members ?? {}), ...Object.keys(b.members ?? {})])].sort();
  const categories = {};
  let equal = a.overall_md5 === b.overall_md5;
  for (const cat of cats) {
    const ma = a.members?.[cat] ?? {};
    const mb = b.members?.[cat] ?? {};
    const onlyBaseline = Object.keys(ma).filter((k) => !(k in mb)).sort();
    const onlyPlain = Object.keys(mb).filter((k) => !(k in ma)).sort();
    const changed = Object.keys(ma).filter((k) => k in mb && ma[k] !== mb[k]).sort();
    const same = onlyBaseline.length + onlyPlain.length + changed.length === 0;
    if (!same) equal = false;
    categories[cat] = {
      baselineCount: Object.keys(ma).length,
      plainCount: Object.keys(mb).length,
      equal: same,
      onlyBaseline: onlyBaseline.slice(0, 100),
      onlyPlain: onlyPlain.slice(0, 100),
      changed: changed.slice(0, 100),
    };
  }
  return { compared: true, equal, overall: { baseline: a.overall_md5, plain: b.overall_md5 }, categories };
}
const fingerprint = compareFingerprints(baseline.fingerprint, plain.fingerprint);

// ---------------------------------------------------------------- captures
const stable = (v) => JSON.stringify(v, Object.keys(v ?? {}).sort());
function diffObjects(a = {}, b = {}) {
  const out = { onlyBaseline: [], onlyPlain: [], different: [] };
  for (const k of Object.keys(a)) if (!(k in b)) out.onlyBaseline.push(k);
  for (const k of Object.keys(b)) if (!(k in a)) out.onlyPlain.push(k);
  for (const k of Object.keys(a)) {
    if (k in b && JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.different.push({ name: k, baseline: a[k], plain: b[k] });
  }
  return out;
}
function compareCaptures(a, b) {
  if (!a || !b) return { compared: false };
  const da = a.db ?? {};
  const db = b.db ?? {};
  const roleNames = ['anon', 'authenticated', 'service_role', 'authenticator', 'postgres', 'supabase_auth_admin', 'supabase_storage_admin'];
  const roles = {};
  for (const r of roleNames) {
    if (JSON.stringify(da.roles?.[r]) !== JSON.stringify(db.roles?.[r])) roles[r] = { baseline: da.roles?.[r] ?? null, plain: db.roles?.[r] ?? null };
  }
  const svc = { rest: 'rest14', auth: 'auth', storage: 'storage' };
  const env = {};
  for (const [bs, ps] of Object.entries(svc)) {
    const ea = a.env?.[bs];
    const eb = b.env?.[ps];
    if (!ea || !eb) {
      env[`${bs}/${ps}`] = { missing: !ea ? 'baseline' : 'plain' };
      continue;
    }
    const d = diffObjects(ea, eb);
    d.different = d.different.filter((x) => x.baseline !== '(redacted)' || x.plain !== '(redacted)');
    env[`${bs}/${ps}`] = d;
  }
  return {
    compared: true,
    serverVersion: { baseline: da.server_version, plain: db.server_version },
    migrationsRunAsSuperuser: { baseline: da.current_user_is_superuser, plain: db.current_user_is_superuser },
    database: JSON.stringify(da.database) === JSON.stringify(db.database) ? 'equal' : { baseline: da.database, plain: db.database },
    settings: diffObjects(da.settings, db.settings),
    databaseSettings: { baseline: da.database_settings ?? [], plain: db.database_settings ?? [] },
    roles,
    rolesOnlyBaseline: Object.keys(da.roles ?? {}).filter((r) => !(r in (db.roles ?? {}))).sort(),
    rolesOnlyPlain: Object.keys(db.roles ?? {}).filter((r) => !(r in (da.roles ?? {}))).sort(),
    schemas: diffObjects(da.schemas, db.schemas),
    defaultPrivileges: { equal: stable(da.default_privileges) === stable(db.default_privileges), baseline: da.default_privileges, plain: db.default_privileges },
    extensions: diffObjects(da.extensions, db.extensions),
    availableExtensions: { baseline: da.available_extensions_of_interest, plain: db.available_extensions_of_interest },
    publications: diffObjects(da.publications, db.publications),
    eventTriggers: diffObjects(da.event_triggers, db.event_triggers),
    authTables: diffObjects(Object.fromEntries((da.auth_tables ?? []).map((t) => [t, 1])), Object.fromEntries((db.auth_tables ?? []).map((t) => [t, 1]))),
    storageTables: diffObjects(Object.fromEntries((da.storage_tables ?? []).map((t) => [t, 1])), Object.fromEntries((db.storage_tables ?? []).map((t) => [t, 1]))),
    authStorageRelations: diffObjects(da.relations_auth_storage_extensions, db.relations_auth_storage_extensions),
    authFunctions: { baseline: da.auth_functions, plain: db.auth_functions },
    buckets: { baseline: da.buckets, plain: db.buckets },
    token: { baseline: a.token, plain: b.token },
    env,
  };
}
const captures = compareCaptures(baseline.capture, plain.capture);

// ---------------------------------------------------------------- suites
function vitestSummary(report) {
  if (!report) return null;
  const files = (report.testResults ?? []).map((r) => {
    const tests = r.assertionResults ?? [];
    const count = (s) => tests.filter((t) => t.status === s).length;
    return {
      file: String(r.name).replace(/^.*\/crm\//, ''),
      passed: count('passed'),
      failed: count('failed'),
      skipped: tests.filter((t) => ['skipped', 'pending', 'todo'].includes(t.status)).length,
      fileError: tests.length === 0 && r.status === 'failed' ? String(r.message ?? '').slice(0, 400) : null,
      firstFailure: (tests.find((t) => t.status === 'failed')?.failureMessages ?? [])[0]?.slice(0, 400) ?? null,
      firstFailedTest: tests.find((t) => t.status === 'failed')?.fullName ?? null,
    };
  });
  const sum = (k) => files.reduce((n, f) => n + f[k], 0);
  return {
    files: files.length,
    filesFailed: files.filter((f) => f.failed > 0 || f.fileError).length,
    filesAllSkipped: files.filter((f) => f.passed === 0 && f.failed === 0 && !f.fileError).length,
    tests: { passed: sum('passed'), failed: sum('failed'), skipped: sum('skipped') },
    failedFiles: files.filter((f) => f.failed > 0 || f.fileError),
    skippedFiles: files.filter((f) => f.passed === 0 && f.failed === 0 && !f.fileError).map((f) => f.file),
    perFile: files.map((f) => `${f.file} ${f.passed}/${f.failed}/${f.skipped}`),
  };
}
function playwrightSummary(report) {
  if (!report) return null;
  const tests = [];
  const walk = (s) => {
    for (const spec of s.specs ?? []) for (const t of spec.tests) tests.push({ file: spec.file, title: spec.title, status: t.status, results: t.results.map((r) => r.status), error: t.results.map((r) => r.error?.message).find(Boolean) ?? null });
    for (const c of s.suites ?? []) walk(c);
  };
  for (const s of report.suites ?? []) walk(s);
  const required = ['accounts.real.e2e.ts', 'journey.real.e2e.ts', 'b11-journey.real.e2e.ts', 'b12-quote-to-booking.real.e2e.ts', 'b2-autofill.real.e2e.ts', 'b3-referral.real.e2e.ts', 'bookform-journey.real.e2e.ts'];
  const perFile = required.map((file) => {
    const mine = tests.filter((t) => t.file.split('/').pop() === file);
    const passed = mine.filter((t) => t.status === 'expected' && t.results.includes('passed')).length;
    return { file, tests: mine.length, passed, ok: mine.length > 0 && passed === mine.length, firstError: mine.find((t) => t.status !== 'expected')?.error?.slice(0, 400) ?? null };
  });
  return { requiredFiles: required.length, filesPassed: perFile.filter((f) => f.ok).length, perFile };
}
const MUST_PASS = ['real-stack.test.ts', 'session-recovery', 'intake', 'intake-routes', 'intake-receiver', 'finance-concurrency', 'b1-journey', 'b11-won-only',
  'booking', 'booking-flow', 'booking-form', 'procurement', 'deals-visibility', 'lead-scope', 'lead-screens', 'search', 'speed-deals-list']
  .map((f) => (f.endsWith('.ts') ? `tests/supabase/${f}` : `tests/supabase/${f}.real.test.ts`));
const realSummary = vitestSummary(plain.real);
const brSummary = vitestSummary(plain.br);
const mustPass = MUST_PASS.concat('tests/supabase/br-postgrest-loop.real.test.ts').map((file) => {
  const source = file.includes('br-postgrest-loop') ? plain.br : plain.real;
  const suite = (source?.testResults ?? []).find((r) => String(r.name).endsWith(`/${file}`));
  const tests = suite?.assertionResults ?? [];
  const passed = tests.filter((t) => t.status === 'passed').length;
  return { file, tests: tests.length, passed, ok: tests.length > 0 && passed === tests.length };
});
const suites = {
  db: vitestSummary(plain.db),
  realStack: realSummary,
  brPostgrestLoop: brSummary,
  mustPass,
  excluded: vitestSummary(plain.excluded),
  proofTests: vitestSummary(plain.proofTests),
  speedInformation: vitestSummary(plain.speed),
  journeys: playwrightSummary(plain.journeys),
};

// ---------------------------------------------------------------- proofs
const proofs = plain.proofs ?? {};
const g0 = plain.g0 ?? {};
const pinnedPt409 = g0.scratch?.['pinned-pt409'];
const realPinned = g0.real?.['pinned-40001'];

// ---------------------------------------------------------------- acceptance
const bucketsPlain = plain.capture?.db?.buckets ?? [];
const nonLoopback = (plain.ports ?? '').split('\n').filter((l) => /0\.0\.0\.0:|:::|\[::\]:/.test(l));
const acceptance = {
  A1: {
    pass: Boolean(plain.ports) && nonLoopback.length === 0 && /synthetic users ready/.test(plain.seedLog ?? ''),
    evidence: { nonLoopbackPorts: nonLoopback, seedGuardAndSeed: /synthetic users ready/.test(plain.seedLog ?? '') ? 'seed-local.mjs passed its guards and seeded' : 'seed log missing or seed failed' },
  },
  A2: { pass: plain.migrations ? plain.migrations.applied === plain.migrations.total && !plain.migrations.failedFile : false, evidence: plain.migrations },
  A3: { pass: fingerprint.compared ? fingerprint.equal && bucketsPlain.length === (baseline.capture?.db?.buckets ?? []).length : false, evidence: { fingerprintEqual: fingerprint.equal ?? null, bucketsPlain: bucketsPlain.length, bucketsBaseline: (baseline.capture?.db?.buckets ?? []).length } },
  A4: { pass: suites.db ? suites.db.filesFailed === 0 && suites.db.tests.failed === 0 : false, evidence: suites.db ? { files: suites.db.files, tests: suites.db.tests, skippedFiles: suites.db.skippedFiles } : 'db report missing' },
  A5: { pass: mustPass.every((m) => m.ok), evidence: mustPass.filter((m) => !m.ok) },
  A6: {
    pass: ['P1', 'P4', 'P5'].every((p) => proofs[p]) && pinnedPt409?.executionsTotal === 1 && pinnedPt409?.http?.status === 409
      && Boolean(suites.proofTests) && suites.proofTests.files > 0 && suites.proofTests.filesFailed === 0 && suites.proofTests.tests.skipped === 0
      && mustPass.find((m) => m.file.includes('session-recovery'))?.ok === true && mustPass.find((m) => m.file.includes('intake-routes'))?.ok === true,
    evidence: { P3pinnedPT409: pinnedPt409 ?? 'missing', P3real4a: realPinned ?? 'missing', proofsPresent: Object.keys(proofs), proofTests: suites.proofTests ? suites.proofTests.perFile : 'missing' },
  },
  A7: { pass: suites.journeys ? suites.journeys.filesPassed === suites.journeys.requiredFiles : false, evidence: suites.journeys ?? 'journeys report missing' },
  A8: { pass: true, evidence: 'gap rows below; dispositions are finalised in the results file (13)' },
  A9: { pass: null, evidence: 'checked by the lead: git diff --stat against the base and a ci.yml run on the same head' },
  A10: { pass: null, evidence: 'independent review (not done by this job)' },
};

// ---------------------------------------------------------------- gaps
const excludedFiles = ['auto-sync', 'auto-sync-health', 's4-event-kick', 's4-no-missed-event', 'sync-completion'];
const gaps = [
  { id: 'G1', object: 'roles anon, authenticated, service_role', plan: 'shim', observed: captures.roles ? Object.keys(captures.roles).filter((r) => ['anon', 'authenticated', 'service_role'].includes(r)) : null },
  { id: 'G1b', object: 'roles authenticator, supabase_auth_admin, supabase_storage_admin', plan: 'shim', observed: captures.roles ? Object.keys(captures.roles).filter((r) => ['authenticator', 'supabase_auth_admin', 'supabase_storage_admin', 'postgres'].includes(r)) : null },
  { id: 'G2', object: 'auth schema, auth.uid(), auth.jwt(), auth tables', plan: 'shim + self-run GoTrue', observed: { shimNotices: plain.shimNotices, authTables: captures.authTables, authFunctions: captures.authFunctions } },
  { id: 'G3', object: 'storage schema, buckets, objects', plan: 'self-run storage-api', observed: { storageTables: captures.storageTables, buckets: captures.buckets, P4: proofs.P4 ?? null } },
  { id: 'G4', object: 'pg_cron', plan: 'skip; outside scheduler (P5)', observed: { availablePlain: plain.capture?.db?.available_extensions_of_interest?.pg_cron ?? null, P5: proofs.P5 ?? null } },
  { id: 'G5', object: 'pg_net + Vault (kick, timer, push)', plan: 'skip; measured in P5', observed: { availablePlain: { pg_net: plain.capture?.db?.available_extensions_of_interest?.pg_net ?? null, supabase_vault: plain.capture?.db?.available_extensions_of_interest?.supabase_vault ?? null }, P5dispatches: proofs.P5?.dispatchesSinceStart ?? null } },
  { id: 'G6', object: 'pgsodium, pg_graphql, supabase_vault, graphql_public', plan: 'skip', observed: captures.extensions ?? null },
  { id: 'G7', object: 'supabase_realtime publication', plan: 'shim (empty publication)', observed: captures.publications ?? null },
  { id: 'G8', object: 'extensions schema, pg_stat_statements', plan: 'shim', observed: { extensions: captures.extensions ?? null, g0PreambleCounted: realPinned?.preambleCallsDuringCase ?? null } },
  { id: 'G9', object: 'Kong gateway and API-key check', plan: 'nginx stand-in with a header check', observed: 'front door answered 401 without a key (up.sh)' },
  { id: 'G10', object: 'e-mail templates and sender', plan: 'templates over HTTP, Mailpit', observed: mustPass.find((m) => m.file.includes('session-recovery')) ?? null },
  { id: 'G11', object: 'Edge Function bitrix-events (Deno)', plan: 'skip; Next.js route twin tested', observed: mustPass.find((m) => m.file.includes('intake-routes')) ?? null },
  { id: 'G12', object: 'CLI db reset / db lint / gen types', plan: 'skip; replaced by apply-migrations.sh and the fingerprint', observed: { migrations: plain.migrations, fingerprintEqual: fingerprint.equal ?? null } },
  { id: 'G13', object: 'sync health text without pg_cron', plan: 'measure', observed: proofs.G13 ?? null },
  { id: 'G14', object: 'PostgREST schema-reload event triggers (pgrst_ddl_watch, pgrst_drop_watch)', plan: 'shim (new row)', observed: captures.eventTriggers ?? null },
  { id: 'G15', object: 'authenticator session_preload_libraries (supautils, safeupdate)', plan: 'skip (new row)', observed: captures.roles?.authenticator ?? 'equal or missing capture' },
  { id: 'G16', object: 'token signing method', plan: 'HS256 shared secret in the plain stack (new row)', observed: captures.token ?? null },
  { id: 'G17', object: 'excluded suites (need pg_cron / pg_net / Vault)', plan: 'skip with reason', observed: suites.excluded ? suites.excluded.perFile.filter((l) => excludedFiles.some((f) => l.includes(`/${f}.real.test.ts`))) : 'not run' },
  { id: 'G18', object: 'no-superuser apply (P9, information)', plan: 'measure', observed: plain.probe ?? null },
];

const report = {
  generatedAt: new Date().toISOString(),
  run: { id: process.env.GITHUB_RUN_ID ?? null, sha: process.env.GITHUB_SHA ?? null, ref: process.env.GITHUB_REF_NAME ?? null },
  versions: { baseline: baseline.capture?.images ?? null, plain: plain.capture?.images ?? null },
  timings: plain.timings,
  acceptance,
  fingerprint,
  captures,
  suites,
  proofs,
  g0: { pinnedPt409: pinnedPt409 ?? null, realPinned40001: realPinned ?? null, versions: g0.versions ?? null, realDefault: g0.real?.['default-40001'] ?? null },
  gaps,
};
writeFileSync(join(outDir, 'gap-report.json'), `${JSON.stringify(report, null, 2)}\n`);

// ---------------------------------------------------------------- summary
const yesNo = (v) => (v === true ? 'pass' : v === false ? 'FAIL' : 'not judged here');
const lines = [
  '## Fallback plain stack (architecture C1): CI result',
  '',
  `Run ${report.run.id ?? '?'} on ${report.run.sha ?? '?'}. Synthetic data only.`,
  '',
  '| Check | Result |',
  '|---|---|',
  ...Object.entries(acceptance).map(([k, v]) => `| ${k} | ${yesNo(v.pass)} |`),
  '',
  `Migrations: ${plain.migrations ? `${plain.migrations.applied}/${plain.migrations.total}${plain.migrations.failedFile ? `, first failure ${plain.migrations.failedFile} (${plain.migrations.sqlstate})` : ''}` : 'missing'}`,
  `Fingerprint: ${fingerprint.compared ? (fingerprint.equal ? 'equal to the baseline' : 'DIFFERENT from the baseline') : fingerprint.reason}`,
];
if (fingerprint.compared && !fingerprint.equal) {
  for (const [cat, c] of Object.entries(fingerprint.categories)) {
    if (!c.equal) lines.push(`- ${cat}: baseline ${c.baselineCount}, plain ${c.plainCount}; only baseline ${c.onlyBaseline.length}, only plain ${c.onlyPlain.length}, changed ${c.changed.length} (first: ${[...c.onlyBaseline, ...c.onlyPlain, ...c.changed].slice(0, 4).join(', ')})`);
  }
}
if (suites.db) lines.push('', `Database suite: ${suites.db.files} files; tests ${suites.db.tests.passed} passed, ${suites.db.tests.failed} failed, ${suites.db.tests.skipped} skipped; failed files: ${suites.db.failedFiles.map((f) => f.file).join(', ') || 'none'}`);
lines.push(`Must-pass real-stack files: ${mustPass.filter((m) => m.ok).length}/${mustPass.length}${mustPass.some((m) => !m.ok) ? ` (not passing: ${mustPass.filter((m) => !m.ok).map((m) => m.file.replace('tests/supabase/', '')).join(', ')})` : ''}`);
if (suites.journeys) lines.push(`Browser journeys: ${suites.journeys.filesPassed}/${suites.journeys.requiredFiles} files passed`);
lines.push(`Proofs present: ${Object.keys(proofs).filter((k) => /^P|^G/.test(k)).join(', ') || 'none'}`);
if (plain.probe) lines.push(`P9 (information): migrations failing as a non-superuser ${plain.probe.migrations?.failedFiles ?? '?'} of ${plain.probe.migrations?.total ?? '?'}; bypassrls role creation ${plain.probe.createBypassRlsRole?.ok ? 'allowed' : 'refused'}`);
lines.push('', 'Full detail: artifact plain-gap-report (gap-report.json).');
const summary = `${lines.join('\n')}\n`;
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(summary);
