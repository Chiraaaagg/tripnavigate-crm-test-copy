import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Scope guards.
 *  - T17 / N07: the agent portal (D26) is excluded. No routes, files, tables,
 *    roles or identifiers for agents, wallets, KYC, commissions or B2B exist.
 *  - Synthetic fixtures are never part of a production path: only the local
 *    seed script and the test harness may reference supabase/fixtures.
 */

const crm = join(import.meta.dirname, '..', '..');
const repo = join(crm, '..');

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.next' || name === '.temp' || name === '.branches') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const rel = (file: string) => relative(crm, file).split(sep).join('/');
const srcFiles = walk(join(crm, 'src'));
const supabaseFiles = walk(join(crm, 'supabase'));

/** Strips SQL comments (-- line and block). */
function sqlCode(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--.*$/gm, ' ');
}
/** Strips TS/JS comments (block and whole-line or trailing // comments). */
function tsCode(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/.*$/gm, '$1');
}

const EXCLUDED_PATH = /(^|[/_.-])(agents?|agent-portal|wallets?|kyc|commissions?|b2b)([/_.-]|$)/i;
const EXCLUDED_IDENTIFIER = /\b(agent_\w+|agents?|wallets?\w*|kyc\w*|commissions?\w*|b2b\w*)\b/i;

describe('agent portal exclusion (T17 / N07)', () => {
  it('no source, route or Supabase file is named after agent-portal concepts', () => {
    const offenders = [...srcFiles, ...supabaseFiles].map(rel).filter((p) => EXCLUDED_PATH.test(p));
    expect(offenders).toEqual([]);
  });

  it('no SQL identifier or literal for agents, wallets, KYC, commissions or B2B', () => {
    const offenders: string[] = [];
    for (const file of supabaseFiles.filter((f) => /\.(sql|toml)$/.test(f))) {
      const code = sqlCode(readFileSync(file, 'utf8'));
      const hit = EXCLUDED_IDENTIFIER.exec(code);
      if (hit) offenders.push(`${rel(file)}: ${hit[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it('no application code identifier, role or route for agent-portal concepts', () => {
    const offenders: string[] = [];
    for (const file of srcFiles.filter((f) => /\.(ts|tsx|css)$/.test(f))) {
      const code = tsCode(readFileSync(file, 'utf8'));
      const hits = [
        /\bagent_\w+/i.exec(code),
        /['"`/]agents?(['"`/]|-portal)/i.exec(code),
        /\b(wallets?|kyc|commissions?|b2b)\w*/i.exec(code),
      ].filter(Boolean);
      for (const hit of hits) offenders.push(`${rel(file)}: ${hit![0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the guard itself detects what it must forbid', () => {
    expect(EXCLUDED_PATH.test('src/app/agent/page.tsx')).toBe(true);
    expect(EXCLUDED_PATH.test('src/app/agent-portal/page.tsx')).toBe(true);
    expect(EXCLUDED_PATH.test('supabase/migrations/2026_wallets.sql')).toBe(true);
    expect(EXCLUDED_PATH.test('src/modules/deals/server/queries.ts')).toBe(false);
    expect(EXCLUDED_IDENTIFIER.test(sqlCode('create table public.agent_wallets (id uuid);'))).toBe(true);
    expect(EXCLUDED_IDENTIFIER.test(sqlCode("insert into public.roles (code) values ('agent');"))).toBe(true);
    expect(EXCLUDED_IDENTIFIER.test(sqlCode('-- the agent portal is excluded (D26)\nselect 1;'))).toBe(false);
    expect(EXCLUDED_IDENTIFIER.test(sqlCode('select user_agent from x;'))).toBe(false);
    expect(EXCLUDED_IDENTIFIER.test(sqlCode('create table public.deal_commercials ();'))).toBe(false);
  });
});

describe('synthetic fixtures stay out of production paths', () => {
  const fixtureNames = walk(join(crm, 'supabase', 'fixtures')).map((f) => f.split(sep).pop()!);
  const ALLOWED = new Set(['scripts/seed-local.mjs']);

  it('fixtures exist and are only referenced by the seed script among shipped/runtime files', () => {
    expect(fixtureNames.length).toBeGreaterThan(0);
    const scanned = [
      ...srcFiles,
      ...walk(join(crm, 'scripts')),
      ...supabaseFiles.filter((f) => !f.includes(`${sep}fixtures${sep}`)),
      join(crm, 'next.config.ts'),
      join(crm, 'package.json'),
      ...walk(join(repo, '.github')),
    ];
    const offenders: string[] = [];
    for (const file of scanned) {
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const code = /\.(sql)$/.test(file) ? sqlCode(text) : /\.(m?[jt]sx?)$/.test(file) ? tsCode(text) : text;
      const mentions =
        fixtureNames.some((name) => code.includes(name)) ||
        /['"`]fixtures['"`]/.test(code) ||
        /supabase\/fixtures/.test(code);
      if (mentions && !ALLOWED.has(rel(file))) offenders.push(rel(file));
    }
    expect(offenders).toEqual([]);
  });

  it('the Supabase CLI never seeds fixtures automatically', () => {
    const config = readFileSync(join(crm, 'supabase', 'config.toml'), 'utf8');
    const seedSection = /\[db\.seed\]([\s\S]*?)(\n\[|$)/.exec(config)?.[1] ?? '';
    expect(seedSection).toMatch(/enabled\s*=\s*false/);
    expect(seedSection).not.toMatch(/fixtures/);
  });

  it('migrations never load fixture files', () => {
    for (const file of supabaseFiles.filter((f) => f.includes(`${sep}migrations${sep}`))) {
      expect(sqlCode(readFileSync(file, 'utf8'))).not.toMatch(/\\i|\\include|fixtures/);
    }
  });
});
