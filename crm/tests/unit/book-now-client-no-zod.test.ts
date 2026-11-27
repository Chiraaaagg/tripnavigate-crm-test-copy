/**
 * Book now runs in the browser under `script-src 'self'`. Zod 4 builds every
 * object schema with a JIT check that calls `new Function('')` once per page;
 * the CSP blocks it and the browser reports a `script-src` "eval" violation
 * even though zod swallows the error. So no 'use client' file under
 * src/views/booking-form may reach, at runtime, a module that imports zod and
 * builds an object schema (directly or through the modules it imports).
 * zod/mini scalar fields such as z.uuid() never run the check and are allowed.
 *
 * Regression: ROUTES from '@/modules/identity/session-policy' (which builds a
 * zod schema at module load) was imported by two booking-form client files and
 * made every real browser journey report "script-src blocked eval" on
 * /app/deals/<id>/book/*. ROUTES now lives in the zod-free
 * '@/modules/identity/contracts'.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = join(process.cwd(), 'src');

function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith('@/') ? join(src, spec.slice(2)) : spec.startsWith('.') ? join(dirname(from), spec) : null;
  if (!base) return null;
  if (/\.tsx?$/.test(base) && existsSync(base)) return base;
  for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx']) if (existsSync(base + ext)) return base + ext;
  return null;
}

/** Runtime (non type-only) import and re-export specifiers of a file. */
function runtimeImports(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/^\s*(?:import|export)\s+(?!type\b)([\s\S]*?)\s+from\s+'([^']+)'/gm)) {
    const clause = m[1]!.trim();
    // import { type A, type B } from '...' is type-only too.
    if (/^\{[^}]*\}$/.test(clause) && clause.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean).every((x) => x.startsWith('type '))) continue;
    out.push(m[2]!);
  }
  for (const m of code.matchAll(/^\s*import\s+'([^']+)'/gm)) out.push(m[1]!);
  return out;
}

const isUseServer = (code: string) => /^\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*['"]use server['"]/.test(code);
const isUseClient = (code: string) => /^\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*['"]use client['"]/.test(code);

/** z.object, z.strictObject, z.looseObject (also chained as `z\n  .object(`). */
const buildsObjectSchema = (code: string) => /(?:^|[^\w$])z\s*\.\s*(?:object|strictObject|looseObject)\s*\(/m.test(code);

function clientRoots(): string[] {
  const dir = join(src, 'views/booking-form');
  return readdirSync(dir)
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => join(dir, name))
    .filter((file) => isUseClient(readFileSync(file, 'utf8')));
}

describe('no zod in the browser graph of the booking forms', () => {
  it('no booking-form client file reaches a zod object schema at runtime', () => {
    const roots = clientRoots();
    expect(roots.length).toBeGreaterThan(10);
    const parent = new Map<string, string | null>(roots.map((r) => [r, null]));
    const stack = [...roots];
    const hits: string[] = [];
    while (stack.length) {
      const file = stack.pop()!;
      const code = readFileSync(file, 'utf8');
      // A 'use server' module is only a reference in the browser bundle.
      if (isUseServer(code)) continue;
      for (const spec of runtimeImports(code)) {
        if (spec === 'zod' || spec.startsWith('zod/')) {
          if (!buildsObjectSchema(code)) continue;
          const chain: string[] = [];
          for (let f: string | null | undefined = file; f; f = parent.get(f)) chain.unshift(relative(src, f));
          hits.push(chain.join(' -> '));
          continue;
        }
        const next = resolveImport(file, spec);
        if (next && !parent.has(next)) {
          parent.set(next, file);
          stack.push(next);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
