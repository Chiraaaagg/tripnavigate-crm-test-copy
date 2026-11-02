#!/usr/bin/env node
// READ-ONLY three-way count check: Bitrix vs local Supabase (LOCAL only).
//
//   node scripts/bitrix-count-audit.mjs [--cutoff YYYY-MM-DD] [--rule create|modify] [--all-stages] [--ids]
//
// Bitrix:   crm.deal.list (IDs + dates only), all pages, with the configured
//           pipelines (@CATEGORY_ID) and stages (@STAGE_ID, unless --all-stages)
//           and the sync date: --rule create (default) = >=DATE_CREATE at
//           00:00 IST of the sync date (the rule since 20261008000100);
//           --rule modify = the old >=DATE_MODIFY entry filter.
// Supabase: deals with source_system = 'bitrix' that are NOT removed (service
//           connection to the local database).
// Prints counts and the IDs missing on either side (with --ids, every ID).
// Never prints the webhook URL. Calls crm.deal.list only.
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { redact, resolveBaseUrl } from './lib/bitrix-metadata.mjs';

const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .map((l) => /^\s*([A-Z_]+)\s*=\s*(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim()]),
);
const secrets = [env.BITRIX_WEBHOOK_BASE_URL];
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (name) => process.argv.includes(name);
if (env.APP_ENV !== 'local') throw new Error('runs only with APP_ENV=local');

const db = new pg.Client({ connectionString: DB_URL });
await db.connect();
const cfg = (await db.query(
  `select portal_domain, portal_member_id, coalesce(eligible_category_ids, array[category_id]) cats, eligible_stage_ids, cutoff_at
   from public.integration_intake_config where enabled`,
)).rows[0];
if (!cfg) throw new Error('no enabled intake config');

const cutoffDay = arg('--cutoff');
// Sync date = 00:00 Asia/Kolkata (UTC+05:30, no DST) of that day.
const cutoff = cutoffDay ? new Date(`${cutoffDay}T00:00:00+05:30`).toISOString() : new Date(cfg.cutoff_at).toISOString();
const rule = arg('--rule') ?? 'create';
const baseUrl = resolveBaseUrl(env.BITRIX_WEBHOOK_BASE_URL, cfg.portal_domain, 'production');

async function list(filter) {
  const ids = new Map();
  let start = 0;
  let total = null;
  for (let page = 0; page < 2000; page += 1) {
    const res = await fetch(`${baseUrl}crm.deal.list.json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filter, select: ['ID', 'DATE_CREATE', 'DATE_MODIFY', 'STAGE_ID'], order: { ID: 'ASC' }, start }),
    });
    const body = await res.json();
    if (body.error) {
      if (body.error === 'QUERY_LIMIT_EXCEEDED') {
        await new Promise((r) => setTimeout(r, 1500));
        page -= 1;
        continue;
      }
      throw new Error(redact(`Bitrix error ${body.error}`, secrets));
    }
    total ??= body.total;
    for (const d of body.result) ids.set(Number(d.ID), d);
    if (typeof body.next !== 'number') break;
    start = body.next;
    await new Promise((r) => setTimeout(r, 250));
  }
  return { ids, total };
}

const filter = { '@CATEGORY_ID': cfg.cats.map(Number) };
if (!flag('--all-stages')) filter['@STAGE_ID'] = cfg.eligible_stage_ids;
filter[rule === 'modify' ? '>=DATE_MODIFY' : '>=DATE_CREATE'] = cutoff;
const bitrix = await list(filter);

const stored = (await db.query(
  `select source_deal_id::bigint id, removed_at is not null removed, source_created_at
   from public.deals where source_system = 'bitrix' and source_portal = $1`,
  [cfg.portal_member_id],
).catch(async () =>
  db.query(
    `select source_deal_id::bigint id, false removed, source_created_at from public.deals
     where source_system = 'bitrix' and source_portal = $1`,
    [cfg.portal_member_id],
  ),
)).rows;
await db.end();

const live = new Map(stored.filter((r) => !r.removed).map((r) => [Number(r.id), r]));
const missing = [...bitrix.ids.keys()].filter((id) => !live.has(id));
const extra = [...live.keys()].filter((id) => !bitrix.ids.has(id));

console.log(JSON.stringify({
  syncDateUtc: cutoff,
  rule,
  stages: flag('--all-stages') ? 'all' : cfg.eligible_stage_ids.length,
  bitrixTotalField: bitrix.total,
  bitrixIds: bitrix.ids.size,
  supabaseStored: live.size,
  supabaseRemoved: stored.length - live.size,
  missingInSupabase: missing.length,
  extraInSupabase: extra.length,
  missingSample: missing.slice(0, flag('--ids') ? undefined : 10),
  extraSample: extra.slice(0, flag('--ids') ? undefined : 10),
  extraCreatedBeforeSyncDate: extra.filter((id) => new Date(live.get(id).source_created_at) < new Date(cutoff)).length,
}, null, 2));
