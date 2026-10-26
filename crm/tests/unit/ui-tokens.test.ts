import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'tailwindcss';
import { describe, expect, it } from 'vitest';

/**
 * Guards for the shared design system (src/components/ui) living next to the
 * legacy stylesheet (src/app/globals.css) without changing existing screens:
 *  1. token names never reuse a legacy custom property name;
 *  2. Tailwind only scans the design-system folders, and never generates a
 *     utility whose class name the legacy markup or stylesheet uses
 *     (mt-1, mt-2, mt-15, mb-0 exist there with different values);
 *  3. the Direction A colour pairs keep their WCAG contrast.
 */

const crm = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const src = join(crm, 'src');
const read = (path: string) => readFileSync(path, 'utf8');

const entryPath = join(src, 'app/app.css');
const tokensPath = join(src, 'components/ui/tokens.css');
const legacyPath = join(src, 'app/globals.css');
const UI_DIRS = [join(src, 'components/ui'), join(src, 'app/preview/ui-gallery'), join(src, 'views/b11'), join(src, 'views/b12'), join(src, 'views/deal-workspace'), join(src, 'views/booking-form'), join(src, 'views/settings'), join(src, 'views/department'), join(src, 'views/accounts')];
/** Single files of screens already moved to the design system (one @source line each). */
const UI_FILES = [
  join(src, 'views/StaffShell.tsx'),
  join(src, 'views/user-menu-dismiss.tsx'),
  join(src, 'components/NavLinks.tsx'),
  join(src, 'app/app/loading.tsx'),
  // Direction A R0 (19 October 2026): the staff frame's page error.
  join(src, 'app/app/error.tsx'),
  join(src, 'app/layout.tsx'),
  join(src, 'views/home-view.tsx'),
  join(src, 'views/deals-list-view.tsx'),
  join(src, 'views/deal-page-view.tsx'),
  // B1 (10 October 2026)
  join(src, 'views/service-labels.tsx'),
  join(src, 'views/deal-services-view.tsx'),
  join(src, 'views/intake-views.tsx'),
  join(src, 'views/intake-forms.tsx'),
  join(src, 'views/flight-views.tsx'),
  join(src, 'views/flight-forms.tsx'),
  join(src, 'views/workflow-views.tsx'),
  join(src, 'views/workflow-forms.tsx'),
  // Direction A Batch 1 (19 October 2026)
  join(src, 'views/list-leads.tsx'),
  join(src, 'views/list-parts.tsx'),
  join(src, 'views/list-rows.tsx'),
  join(src, 'views/list-search.tsx'),
  join(src, 'views/bitrix-names-card.tsx'),
  // Direction A Batch 4 (23 October 2026)
  join(src, 'views/booking-health-views.tsx'),
  join(src, 'views/purchase-views.tsx'),
  join(src, 'views/purchase-forms.tsx'),
  join(src, 'views/procurement-views.tsx'),
  join(src, 'views/finance-views.tsx'),
  join(src, 'views/finance-common.tsx'),
  join(src, 'views/finance-cash-views.tsx'),
  join(src, 'views/finance-destination-views.tsx'),
  join(src, 'app/preview/[state]/batch4-dept-states.tsx'),
];
const scannedFiles = () => [...UI_DIRS.flatMap((d) => filesUnder(d, /\.(tsx?|css)$/)), ...UI_FILES];

function filesUnder(dir: string, pattern: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path, pattern));
    else if (pattern.test(name)) out.push(path);
  }
  return out;
}

function customPropertyNames(css: string): Set<string> {
  const names = new Set<string>();
  for (const match of css.matchAll(/(^|[\s;{])(--[a-zA-Z0-9-]+)\s*:/g)) names.add(match[2]!);
  return names;
}

async function compileCss(css: string) {
  return compile(css, {
    base: dirname(entryPath),
    from: entryPath,
    async loadStylesheet(id, base) {
      const path = id.startsWith('tailwindcss/') ? join(crm, 'node_modules', id) : resolve(base, id);
      return { path, base: dirname(path), content: read(path) };
    },
  });
}

const compileEntry = () => compileCss(read(entryPath));

/** The entry WITHOUT the legacy stylesheet: whatever build() emits is a Tailwind utility. */
const compileUtilitiesOnly = () =>
  compileCss(
    `@import 'tailwindcss/theme.css' layer(theme);\n@import 'tailwindcss/utilities.css' layer(utilities) source(none);\n@import '../components/ui/tokens.css';`,
  );

/** Class names the legacy screens use: legacy stylesheet selectors plus className strings outside the design system. */
function legacyClassNames(): Set<string> {
  const names = new Set<string>();
  const legacyCss = read(legacyPath).replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of legacyCss.matchAll(/\.(-?[a-zA-Z_][a-zA-Z0-9_-]*)/g)) names.add(m[1]!);
  const uiFiles = new Set(scannedFiles());
  for (const file of filesUnder(src, /\.tsx?$/)) {
    if (uiFiles.has(file)) continue;
    for (const m of read(file).matchAll(/className=(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\}|\{([^}]*)\})/g)) {
      const value = m[1] ?? m[2] ?? m[3] ?? m[4] ?? '';
      for (const token of value.match(/[a-zA-Z][a-zA-Z0-9_-]*/g) ?? []) names.add(token);
    }
  }
  return names;
}

describe('design tokens and the legacy stylesheet', () => {
  it('no token reuses a legacy custom property name', () => {
    const legacy = customPropertyNames(read(legacyPath));
    expect(legacy.size).toBeGreaterThan(20);
    const tokens = customPropertyNames(read(tokensPath));
    expect([...tokens].filter((name) => legacy.has(name))).toEqual([]);

    // Tailwind's own default theme variables that tokens.css does not reset.
    // `@theme … reference` blocks are never emitted as variables (inlined only).
    const resetNamespaces = [...read(tokensPath).matchAll(/(--[a-z-]+)-\*\s*:\s*initial/g)].map((m) => `${m[1]}-`);
    expect(resetNamespaces).toEqual(expect.arrayContaining(['--color-', '--text-', '--radius-', '--shadow-']));
    const tailwindTheme = read(join(crm, 'node_modules/tailwindcss/theme.css')).replace(/@theme[^{]*\breference\b[^{]*\{[^}]*\}/g, '');
    const tailwindDefaults = [...customPropertyNames(tailwindTheme)].filter(
      (name) => !resetNamespaces.some((ns) => name.startsWith(ns)),
    );
    expect(tailwindDefaults.filter((name) => legacy.has(name))).toEqual([]);
  });

  it('Tailwind scans only the design-system folders and migrated screen files (no whole-project detection)', async () => {
    const compiled = await compileEntry();
    expect(compiled.root).toBe('none');
    const bases = compiled.sources.map((s) => resolve(s.base, s.pattern));
    expect(bases.sort()).toEqual([...UI_DIRS, ...UI_FILES].sort());
    // Preflight (Tailwind's reset) stays out until the legacy screens move over.
    const entryRules = read(entryPath).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(entryRules).not.toMatch(/@import\s+['"]tailwindcss['"]|preflight/);
    expect(entryRules).toMatch(/@import\s+'\.\/globals\.css'\s+layer\(legacy\)/);
  });

  it('never generates a utility that a legacy class name would pick up', async () => {
    const compiled = await compileUtilitiesOnly();
    const legacy = [...legacyClassNames()];
    const asUtility = legacy.filter((name) => compiled.build([name]).includes(`.${name} {`));
    // The check is live: these legacy helpers ARE Tailwind utilities with other values.
    expect(asUtility).toEqual(expect.arrayContaining(['mt-1', 'mt-2', 'mt-15', 'mb-0']));

    const offenders: string[] = [];
    for (const file of scannedFiles()) {
      const text = read(file);
      for (const name of asUtility) {
        const escaped = name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
        if (new RegExp(`(?<![\\w:/\\[.-])${escaped}(?![\\w./\\]-])`).test(text)) offenders.push(`${file}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ---- Contrast (WCAG 2.x relative luminance) ----

function tokenHex(name: string): string {
  const match = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(read(tokensPath));
  if (!match) throw new Error(`token --color-${name} not found`);
  return match[1]!;
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('Direction A colour contrast', () => {
  // Direction A (owner approval 15 October 2026; lead R0 decision 1): brand blue #004AAD for
  // primary, ring and link text; accent surface #EEF3FB with #003A87 text; muted text #5C5C5C;
  // input border #8A8A8A; orange #F18700 only as a fill behind dark text.
  it('matches the owner-approved brand values', () => {
    expect(tokenHex('brand').toLowerCase()).toBe('#004aad');
    expect(tokenHex('brand-strong').toLowerCase()).toBe('#004aad');
    expect(tokenHex('brand-deep').toLowerCase()).toBe('#003a87');
    expect(tokenHex('brand-tint').toLowerCase()).toBe('#eef3fb');
    expect(tokenHex('brand-accent').toLowerCase()).toBe('#f18700');
    expect(tokenHex('quiet').toLowerCase()).toBe('#5c5c5c');
    expect(tokenHex('control').toLowerCase()).toBe('#8a8a8a');
  });

  it.each([
    // [foreground, background, minimum]
    ['brand-strong', 'card', 4.5],
    ['brand-strong', 'brand-tint', 4.5],
    ['brand-strong', 'brand-tint-2', 4.5],
    ['brand-deep', 'brand-tint', 4.5],
    ['white', 'brand-strong', 4.5],
    ['white', 'brand-deep', 4.5],
    ['white', 'status-danger', 4.5],
    ['white', 'status-danger-strong', 4.5],
    ['ink', 'canvas', 4.5],
    ['copy', 'canvas', 4.5],
    ['quiet', 'wash', 4.5],
    ['faint', 'card', 4.5],
    ['faint', 'canvas', 4.5],
    ['status-success', 'status-success-tint', 4.5],
    ['status-warning', 'status-warning-tint', 4.5],
    ['status-danger', 'status-danger-tint', 4.5],
    ['status-info', 'status-info-tint', 4.5],
    ['status-neutral', 'status-neutral-tint', 4.5],
    ['white', 'ink', 4.5], // tooltip
    ['quiet', 'card', 4.5],
    ['quiet', 'brand-tint', 4.5],
    ['brand-deep', 'brand-tint-2', 4.5],
    ['brand-accent-ink', 'brand-accent', 4.5], // the only allowed use of orange: a fill behind dark text
    // Non-text: icons, large shapes, control edges and focus outline (3:1).
    ['brand', 'card', 3],
    ['control', 'card', 3],
    ['brand-strong', 'canvas', 3],
  ] as const)('%s on %s is at least %s:1', (fg, bg, min) => {
    expect(contrast(tokenHex(fg), tokenHex(bg))).toBeGreaterThanOrEqual(min);
  });

  it('brand orange #F18700 is NOT text-safe on white (a fill behind dark text only)', () => {
    expect(contrast(tokenHex('brand-accent'), tokenHex('card'))).toBeLessThan(4.5);
  });
});
