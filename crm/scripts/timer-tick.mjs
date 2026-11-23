#!/usr/bin/env node
// LOCAL timer tick (Accounts phase 3, contract 5.2 and 16.4): runs the same steps as
// POST /api/integrations/timer (src/modules/timer/server/run.ts) against a disposable
// loopback stack, so local and CI journeys need no cron job. Never for a hosted database.
//
// Usage:
//   APP_ENV=local SUPABASE_SECRET_KEY=... NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
//   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=... NEXT_PUBLIC_SITE_URL=http://127.0.0.1:3000 \
//     node scripts/timer-tick.mjs [--once | --loop [--interval-ms 60000]]
//
// Output: one JSON line per tick with step statuses, counts and codes only (never
// names, amounts, addresses, message text or keys).
// Exit codes: 0 every step ok or skipped (or --loop stopped), 1 refused to start,
// 2 a step failed or timed out (--once).
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const crm = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const line = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const stop = (reason) => {
  process.stderr.write(`${JSON.stringify({ outcome: 'refused_to_start', reason })}\n`);
  process.exit(1);
};

// Environment guard: a local stack on a loopback address only.
const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/;
if (process.env.APP_ENV !== 'local') stop('app_env_not_local');
if (!process.env.SUPABASE_SECRET_KEY) stop('secret_key_missing');
if (!LOOPBACK.test(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '')) stop('local_needs_loopback_url');

async function load() {
  const { runnerImport } = await import('vite');
  const { module } = await runnerImport(join(crm, 'src/modules/timer/server/run.ts'), {
    root: crm,
    logLevel: 'silent',
    resolve: {
      alias: [
        { find: /^@\//, replacement: `${join(crm, 'src')}/` },
        { find: /^server-only$/, replacement: join(crm, 'scripts/lib/server-only-empty.mjs') },
      ],
    },
  });
  return module;
}

const mod = await load().catch(() => stop('timer_unavailable'));
const loop = flag('--loop');
const interval = Math.max(1000, Number(value('--interval-ms') ?? 60000) || 60000);
for (;;) {
  let result;
  try {
    result = await mod.runTimerOnce();
  } catch {
    result = { status: 'partial', steps: [], code: 'unexpected' };
  }
  line({ at: new Date().toISOString(), ...result });
  if (!loop) {
    process.exitCode = result.status === 'ok' ? 0 : 2;
    break;
  }
  await new Promise((r) => setTimeout(r, interval));
}
