import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QuotationGetSchema } from '@/modules/documents/quotation-view';

/**
 * The in-app customer previews render the branded templates as Server
 * Components. react-dom/server cannot load in the Next.js server layer (it
 * throws there), so no module reachable from a preview route may import it,
 * nor the render seam that does (render/html.tsx, render/render-view.ts):
 * those are for the Node render worker and scripts only. Dev mode does not
 * show this failure, so it is checked here on the import graph.
 */

const SRC = resolve(__dirname, '..', '..', 'src');
const ROUTES = [
  'app/app/quotations/[versionId]/preview/page.tsx',
  'app/app/itineraries/[documentId]/preview/page.tsx',
  'app/app/quotations/[versionId]/page.tsx',
  'app/app/itineraries/[documentId]/page.tsx',
];
const FORBIDDEN = [/react-dom\/server/, /render\/html(\.tsx)?$/, /render\/render-view(\.ts)?$/];

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else return null;
  for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) if (existsSync(base + ext) && !base.endsWith('/') && (ext !== '' || /\.(ts|tsx)$/.test(base))) return base + ext;
  return null;
}

function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const specs = [...text.matchAll(/(?:import|export)\s[^'"]*?from\s+'([^']+)'|import\s+'([^']+)'/g)].map((m) => m[1] ?? m[2]!);
  return specs;
}

function graph(entry: string): { files: Set<string>; bad: string[] } {
  const files = new Set<string>();
  const bad: string[] = [];
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const spec of importsOf(file)) {
      if (FORBIDDEN.some((re) => re.test(spec))) bad.push(`${file.slice(SRC.length + 1)} imports ${spec}`);
      const next = resolveImport(file, spec);
      if (next && /\.(ts|tsx)$/.test(next)) stack.push(next);
    }
  }
  return { files, bad };
}

describe('customer preview routes stay renderable in the Next.js server layer', () => {
  for (const route of ROUTES) {
    it(`${route} never reaches react-dom/server or the render seam`, () => {
      const { files, bad } = graph(join(SRC, route));
      expect(files.size).toBeGreaterThan(3);
      expect(bad).toEqual([]);
    });
  }

  it('the quotation preview includes the branded template (the same component the PDF uses)', () => {
    const { files } = graph(join(SRC, ROUTES[0]!));
    expect([...files].some((f) => f.endsWith('modules/documents/render/branded-templates.tsx'))).toBe(true);
  });
});

describe('quotation_get customer view', () => {
  it('accepts a day with a title only (text null), as the editor stores it', () => {
    const parsed = QuotationGetSchema.safeParse({
      reference: 'TQ-1',
      title: 'Goa',
      version: { versionNo: 1, status: 'ready', validUntil: null, sentAt: null, acceptedTier: null },
      trip: { destination: 'Goa', start: '2026-11-10', end: '2026-11-13' },
      pax: { adults: 2, childrenWithBed: 0, childrenNoBed: 0, infants: 0 },
      content: { days: [{ day: 1, title: 'Arrival and beach evening', text: null }], includes: [], excludes: [], terms: [], notes: null },
      tiers: [{ tierKey: 'quoted', label: 'Sea view rooms' }],
      items: [],
      contacts: { contactName: 'Synthetic Customer', mobile: '9876500077', email: null },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.content?.days?.[0]?.text).toBe('');
  });
});
