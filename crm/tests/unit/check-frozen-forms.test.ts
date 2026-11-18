import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applyConfigRule,
  checkFrozen,
  CONFIG_REL,
  configChangeProblems,
  exceptionLines,
  existsNow,
  globToRegExp,
  isFrozen,
  loadConfig,
  normalisePath,
  parseArgs,
  sliceProblems,
} from '../../scripts/ci/check-frozen-forms.mjs';
import type { FrozenFormsConfig } from '../../scripts/ci/check-frozen-forms.mjs';

/**
 * Frozen-forms guard (UX redesign build plan 4.3): a change may touch a
 * frozen path (an approved form, a shared part or stylesheet it imports, or
 * the guard itself) only when the slice's exceptions name it.
 */

const crm = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const src = join(crm, 'src');
/** The real list. Later slices are added at their own start (lead decision), so it may hold only R0. */
const realConfig = loadConfig();
/**
 * Test fixture: the real list plus later slices made up for the tests (the
 * build plan's expected exceptions), so the slice rules are checked without
 * relying on entries the real file does not have yet.
 */
const TEST_SLICES: FrozenFormsConfig['slices'] = {
  R1: { note: 'test: no approved-form exception', allow: [], deletes: [] },
  R2: { note: 'test: O1 and the Book now language card', allow: ['src/views/booking-form/booking-form-screen.tsx', 'src/views/customer-messages/book-now-card.tsx'], deletes: [] },
  R3: {
    note: 'test: O5 to O14',
    allow: ['src/views/purchase/work-tab.tsx', 'src/views/purchase/what-sales-booked.tsx', 'src/views/flight/work-tab.tsx', 'src/views/flight/work-parts.tsx', 'src/views/flight/confirm-tickets.tsx', 'src/views/flight/selection.tsx', 'src/views/visa/passengers.tsx'],
    deletes: [],
  },
  R4: { note: 'test: no approved-form exception', allow: [], deletes: [] },
};
const config: FrozenFormsConfig = { ...realConfig, slices: { ...TEST_SLICES, ...realConfig.slices } };
const script = join(crm, 'scripts/ci/check-frozen-forms.mjs');
const SLICES = ['R0', 'R1', 'R2', 'R3', 'R4'];

function run(...args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(relative(crm, path));
  }
  return out;
}

/** Files the frozen forms import, directly or through other files (static, dynamic and CSS imports). */
function importClosure(): Set<string> {
  const frozenForms = (p: string) =>
    (config.frozen ?? []).some((g) => globToRegExp(g).test(p)) && !(config.notFrozen ?? []).some((g) => globToRegExp(g).test(p));
  const entries = filesUnder(src).filter((p) => /\.(tsx?|css)$/.test(p) && frozenForms(p));
  const resolveSpec = (from: string, spec: string): string | null => {
    let base: string;
    if (spec.startsWith('@/')) base = join(src, spec.slice(2));
    else if (spec.startsWith('.')) base = resolve(dirname(join(crm, from)), spec);
    else return null;
    for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}.css`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
      if (existsSync(c) && statSync(c).isFile()) return relative(crm, c);
    }
    return null;
  };
  const seen = new Set(entries);
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    const text = readFileSync(join(crm, file), 'utf8');
    const specs = /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]|@import\s+['"]([^'"]+)['"]/g;
    for (const m of text.matchAll(specs)) {
      const target = resolveSpec(file, (m[1] ?? m[2] ?? m[3] ?? m[4])!);
      if (target && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  // The root layout imports the stylesheets every form is drawn with.
  seen.add('src/app/app.css');
  for (const m of readFileSync(join(src, 'app/app.css'), 'utf8').matchAll(/@import\s+'\.\/([^']+\.css)'/g)) seen.add(`src/app/${m[1]}`);
  return seen;
}

describe('frozen-forms list', () => {
  it('names files that exist, and a current slice that has an entry', () => {
    for (const p of [...config.frozen, ...(config.importedByForms ?? []), ...(config.guard ?? []), ...(config.notFrozen ?? [])]) {
      if (p.includes('*')) continue;
      expect(existsSync(join(crm, p)), `${p} exists`).toBe(true);
    }
    expect(realConfig.slices.R0).toBeDefined();
    expect(Object.keys(realConfig.slices)).toContain(realConfig.currentSlice);
    for (const slice of Object.keys(realConfig.slices)) expect(SLICES, slice).toContain(slice);
    expect(sliceProblems(realConfig, realConfig.currentSlice!, existsNow)).toEqual([]);
  });

  it('freezes the guard itself and every shared part or stylesheet the approved forms import', () => {
    for (const p of ['scripts/ci/frozen-forms.json', 'scripts/ci/check-frozen-forms.mjs', 'scripts/ci/check-frozen-forms.d.mts']) {
      expect(isFrozen(p, config), p).toBe(true);
    }
    const shared = [...importClosure()].filter((p) => p.startsWith('src/components/') || p.endsWith('.css')).sort();
    expect(shared).toEqual(expect.arrayContaining(['src/components/ui/cn.ts', 'src/components/ui/tabs.tsx', 'src/app/globals.css', 'src/app/app.css']));
    const missing = shared.filter((p) => !isFrozen(p, config));
    expect(missing, 'add these to importedByForms in frozen-forms.json').toEqual([]);
  });

  it('every slice exception is a frozen file; edits exist now, deletes are gone', () => {
    for (const slice of SLICES) expect(sliceProblems(config, slice, existsNow), slice).toEqual([]);
  });

  it('reports a typo, a missing edit and a delete that did not happen; a delete missing now is fine (deleting, or already merged)', () => {
    const cfg = {
      ...config,
      slices: { X: { allow: ['src/views/b11/no-such-file.tsx', 'src/views/home-view.tsx'], deletes: ['src/views/b11/book-screen.tsx', 'src/views/b11/gone.tsx'] } },
    };
    expect(sliceProblems(cfg, 'X', existsNow)).toEqual([
      'X allow: src/views/b11/no-such-file.tsx does not exist',
      'X allow: src/views/home-view.tsx is not frozen (typo?)',
      'X deletes: src/views/b11/book-screen.tsx still exists',
    ]);
    // R0 on main: its four deletes are missing at the base and now. History, not an error (the P1 of the re-review).
    expect(sliceProblems(config, 'R0', () => false).filter((p) => p.includes('deletes'))).toEqual([]);
  });
});

describe('changes to frozen-forms.json itself', () => {
  const clone = () => JSON.parse(JSON.stringify(config)) as typeof config;

  it('allows setting currentSlice and adding a new slice', () => {
    const head = clone();
    head.slices.R5 = { note: 'later slice', allow: ['src/components/ui/tabs.tsx'], deletes: [] };
    head.currentSlice = 'R5';
    expect(configChangeProblems(config, head)).toEqual([]);
    const next = clone();
    next.currentSlice = 'R1';
    expect(configChangeProblems(config, next)).toEqual([]);
  });

  it('refuses any change to a slice that exists at the base, to the frozen lists, or a current slice with no entry', () => {
    const editAllow = clone();
    editAllow.slices.R0!.allow = [...(editAllow.slices.R0!.allow ?? []), 'src/components/ui/cn.ts'];
    expect(configChangeProblems(config, editAllow)).toEqual(['slice R0 changed (only new slices may be added)']);
    const removed = clone();
    delete removed.slices.R4;
    expect(configChangeProblems(config, removed)).toEqual(['slice R4 removed']);
    const unfrozen = clone();
    unfrozen.frozen = unfrozen.frozen.filter((p) => p !== 'src/views/b11/**');
    unfrozen.notFrozen = [...(unfrozen.notFrozen ?? []), 'src/components/ui/cn.ts'];
    expect(configChangeProblems(config, unfrozen)).toEqual(['"frozen" changed', '"notFrozen" changed']);
    const nowhere = clone();
    nowhere.currentSlice = 'R9';
    expect(configChangeProblems(config, nowhere)).toEqual(['currentSlice "R9" has no slice entry']);
  });

  it('applies that rule in place of the allow lists once the base has the file', () => {
    const editAllow = clone();
    editAllow.slices.R0!.allow = [...(editAllow.slices.R0!.allow ?? []), 'src/components/ui/cn.ts'];
    const files = [CONFIG_REL];
    // R0 lists the file (it is new in R0), but an existing slice cannot allow-list a change to itself.
    expect(applyConfigRule(checkFrozen(files, editAllow, 'R0'), files, config, editAllow)).toEqual([CONFIG_REL]);
    // R1 does not list the file, but switching to it is allowed.
    const next = clone();
    next.currentSlice = 'R1';
    expect(applyConfigRule(checkFrozen(files, next, 'R1'), files, config, next)).toEqual([]);
    // Without the file at the base (R0 creating it) the allow list decides.
    expect(applyConfigRule(checkFrozen(files, config, 'R0'), files, null, config)).toEqual([]);
    expect(applyConfigRule(checkFrozen(files, config, 'R1'), files, null, config)).toEqual([CONFIG_REL]);
  });

  it('prints the slice exceptions for the log', () => {
    const lines = exceptionLines(config, 'R0');
    expect(lines[0]).toMatch(/^Slice R0 exceptions/);
    expect(lines).toContain('    crm/src/components/ui/tabs.tsx');
    expect(lines).toContain('    crm/src/views/b11/book-steps.tsx');
    expect(exceptionLines(config, 'R1')).toEqual(expect.arrayContaining(['  allow:', '    (none)']));
  });
});

describe('globToRegExp and normalisePath', () => {
  it('matches ** at any depth and * within one folder', () => {
    expect(globToRegExp('src/views/b11/**').test('src/views/b11/a/b.tsx')).toBe(true);
    expect(globToRegExp('src/views/b11/**').test('src/views/b11x/a.tsx')).toBe(false);
    expect(globToRegExp('src/views/intake-*.tsx').test('src/views/intake-forms.tsx')).toBe(true);
    expect(globToRegExp('src/views/intake-*.tsx').test('src/views/intake/x.tsx')).toBe(false);
    expect(globToRegExp('src/a.tsx').test('src/aXtsx')).toBe(false);
  });

  it('accepts repository-root and Windows paths', () => {
    expect(normalisePath('crm/src/views/b11/x.tsx')).toBe('src/views/b11/x.tsx');
    expect(normalisePath('.\\src\\views\\x.tsx')).toBe('src/views/x.tsx');
  });
});

describe('checkFrozen', () => {
  it('refuses a frozen file outside the slice exceptions', () => {
    expect(checkFrozen(['src/views/booking-form/booking-form-screen.tsx'], config, 'R1')).toEqual(['src/views/booking-form/booking-form-screen.tsx']);
    expect(checkFrozen(['crm/src/components/ui/button.tsx', 'src/components/hand-form.tsx'], config, 'R0')).toEqual([
      'src/components/hand-form.tsx',
      'src/components/ui/button.tsx',
    ]);
    expect(checkFrozen(['src/views/flight/work-tab.tsx'], config, 'R2')).toEqual(['src/views/flight/work-tab.tsx']);
  });

  it('refuses edits to shared parts the forms import, and to the guard, unless the slice lists them', () => {
    expect(checkFrozen(['src/components/ui/tabs.tsx', 'src/app/app.css', 'scripts/ci/frozen-forms.json'], config, 'R0')).toEqual([]);
    expect(checkFrozen(['src/components/ui/tabs.tsx', 'src/components/ui/cn.ts', 'src/app/globals.css', 'scripts/ci/frozen-forms.json'], config, 'R1')).toEqual([
      'scripts/ci/frozen-forms.json',
      'src/app/globals.css',
      'src/components/ui/cn.ts',
      'src/components/ui/tabs.tsx',
    ]);
  });

  it('allows a listed delete only when the file is really deleted, and only in that slice', () => {
    const deleted = () => true;
    expect(checkFrozen(['src/views/b11/book-steps.tsx', 'src/views/b11/step-footer.tsx'], config, 'R0', deleted)).toEqual([]);
    expect(checkFrozen(['src/views/b11/book-steps.tsx'], config, 'R0', () => false)).toEqual(['src/views/b11/book-steps.tsx']);
    expect(checkFrozen(['src/views/b11/book-steps.tsx'], config, 'R3', deleted)).toEqual(['src/views/b11/book-steps.tsx']);
    expect(checkFrozen(['src/views/b11/accounts-claims.tsx'], config, 'R0', deleted)).toEqual(['src/views/b11/accounts-claims.tsx']);
  });

  it('allows the named edits of each slice only in that slice', () => {
    expect(checkFrozen(['src/views/b11/book-screen.tsx'], config, 'R0')).toEqual([]);
    expect(checkFrozen(['src/views/b11/book-screen.tsx'], config, 'R1')).toEqual(['src/views/b11/book-screen.tsx']);
    expect(checkFrozen(['src/views/booking-form/booking-form-screen.tsx'], config, 'R2')).toEqual([]);
    expect(checkFrozen(['src/views/purchase/work-tab.tsx', 'src/views/visa/passengers.tsx'], config, 'R3')).toEqual([]);
  });

  it('leaves unfrozen files and the carved-out desk files alone', () => {
    const free = [
      'src/components/ui/status.tsx',
      'src/components/ui/record-header.tsx',
      'src/views/purchase-views.tsx',
      'src/views/purchase/manager-approvals.tsx',
      'src/views/flight/queue.tsx',
      'src/views/flight/manager-fares.tsx',
      'src/views/visa/deal-visa-card.tsx',
      'src/app/app/purchase/[taskId]/page.tsx',
      'tests/e2e/b11-book-now.e2e.ts',
    ];
    for (const slice of SLICES) expect(checkFrozen(free, config, slice)).toEqual([]);
  });

  it('refuses an unknown slice instead of passing it', () => {
    expect(() => checkFrozen([], config, 'R9')).toThrow(/Unknown slice "R9"/);
  });
});

describe('command line', () => {
  it('exits 0 when clean, 1 listing refused files, 2 on a usage error', () => {
    // book-steps.tsx is gone from the working tree, so the R0 delete is accepted.
    expect(run('--slice', 'R0', '--files', 'src/views/b11/book-steps.tsx', 'src/components/ui/status.tsx').code).toBe(0);
    // The real list (R0 only): an unlisted frozen form is refused.
    const refused = run('--slice', 'R0', '--files', 'crm/src/views/booking-forms.tsx');
    expect(refused.code).toBe(1);
    expect(refused.out).toContain('crm/src/views/booking-forms.tsx');
    expect(run('--slice', 'R0', '--files', 'src/views/b11/book-screen.tsx').code).toBe(0);
    expect(run('--slice').code).toBe(2);
    expect(run('--slice', 'R7', '--files', 'x').code).toBe(2);
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown option/);
    expect(() => parseArgs(['--base', '--files'])).toThrow(/Give a value after --base/);
    // Starts several node processes: allow for a busy machine.
  }, 60_000);

});

/**
 * The git side of the command line, in a throwaway repository (no network, no
 * origin/main, no local main needed): a base commit with the frozen files, then
 * a change committed on top, checked with --base <base sha>. The script and
 * frozen-forms.json are copied in, so the real list is what is checked.
 */
describe('command line against git (throwaway repository)', () => {
  /**
   * mergedR0: the base is main after R0 (the four D2 files already gone, the guard in place,
   * frozen-forms.json with only the R0 slice); otherwise the base is main before R0.
   */
  function makeRepo(mergedR0 = false) {
    const root = mkdtempSync(join(tmpdir(), 'frozen-forms-'));
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=Frozen forms test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    const write = (p: string, text = `// ${p}\n`) => {
      const full = join(root, 'crm', p);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
    };
    git('init', '--quiet');
    write('scripts/ci/check-frozen-forms.mjs', readFileSync(join(crm, 'scripts/ci/check-frozen-forms.mjs'), 'utf8'));
    const baseConfig = JSON.parse(JSON.stringify(config)) as typeof config;
    // Main after R0 holds only the R0 entry, so its current slice is R0 (the real file may already be on a later slice).
    if (mergedR0) {
      baseConfig.slices = { R0: config.slices.R0! };
      baseConfig.currentSlice = 'R0';
    }
    write('scripts/ci/frozen-forms.json', `${JSON.stringify(baseConfig, null, 2)}\n`);
    write('scripts/ci/check-frozen-forms.d.mts');
    // Every slice's listed edit exists at the base (the guard refuses an allow entry that does not exist);
    // before R0 also the four files R0 deletes.
    for (const entry of Object.values(config.slices)) for (const p of entry.allow ?? []) if (!p.startsWith('scripts/ci/') && !p.includes('*')) write(p);
    if (!mergedR0) for (const p of config.slices.R0!.deletes ?? []) write(p);
    for (const p of ['src/components/ui/cn.ts', 'src/views/booking-form/booking-form-screen.tsx', 'src/views/home-view.tsx']) write(p);
    git('add', '-A');
    git('commit', '--quiet', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    const runIn = (...args: string[]) => {
      try {
        return { code: 0, out: execFileSync(process.execPath, [join(root, 'crm/scripts/ci/check-frozen-forms.mjs'), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
      } catch (e) {
        const err = e as { status: number; stdout: string; stderr: string };
        return { code: err.status, out: `${err.stdout}${err.stderr}` };
      }
    };
    const commit = (message: string) => {
      git('add', '-A');
      git('commit', '--quiet', '-m', message);
    };
    const writeConfig = (c: typeof config) => write('scripts/ci/frozen-forms.json', `${JSON.stringify(c, null, 2)}\n`);
    return { root, base, baseConfig, write, writeConfig, commit, runIn, remove: (p: string) => rmSync(join(root, 'crm', p)) };
  }

  it('passes the R0 change: listed edits, listed deletes, new unfrozen files', () => {
    const repo = makeRepo();
    try {
      repo.write('src/views/b11/book-screen.tsx', '// BookStepScreen removed\n');
      repo.write('src/components/ui/tabs.tsx', '// variant pill added\n');
      for (const p of config.slices.R0!.deletes ?? []) repo.remove(p);
      repo.write('src/components/ui/status.tsx');
      repo.commit('R0');
      repo.write('src/views/home-view.tsx', '// uncommitted, not frozen\n');
      const result = repo.runIn('--slice', 'R0', '--base', repo.base);
      expect(result.out).toContain('Frozen forms OK for slice R0');
      expect(result.code, result.out).toBe(0);
      // Without --slice the current slice from frozen-forms.json is used.
      expect(repo.runIn('--base', repo.base).out).toContain(`slice ${config.currentSlice}`);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  }, 60_000);

  it('refuses a frozen edit, a delete of an unlisted frozen file, and the same change in another slice', () => {
    const repo = makeRepo();
    try {
      for (const p of config.slices.R0!.deletes ?? []) repo.remove(p);
      repo.write('src/components/ui/cn.ts', '// edited\n');
      repo.remove('src/views/booking-form/booking-form-screen.tsx');
      repo.commit('bad change');
      const r0 = repo.runIn('--slice', 'R0', '--base', repo.base);
      expect(r0.code, r0.out).toBe(1);
      expect(r0.out).toContain('crm/src/components/ui/cn.ts');
      expect(r0.out).toContain('crm/src/views/booking-form/booking-form-screen.tsx');
      // Listed in the printed exceptions (four spaces), never among the refused files (two spaces).
      expect(r0.out).not.toMatch(/^  crm\/src\/views\/b11\/book-steps\.tsx$/m);
      const r1 = repo.runIn('--slice', 'R1', '--base', repo.base);
      expect(r1.code, r1.out).toBe(1);
      expect(r1.out).toMatch(/^  crm\/src\/views\/b11\/book-steps\.tsx$/m);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  }, 60_000);

  it('reports a configuration error when a listed delete did not happen (checked against the base commit)', () => {
    const repo = makeRepo();
    try {
      const [kept, ...rest] = config.slices.R0!.deletes ?? [];
      for (const p of rest) repo.remove(p);
      repo.write(kept!, '// edited instead of deleted\n');
      repo.commit('incomplete delete');
      const result = repo.runIn('--slice', 'R0', '--base', repo.base);
      expect(result.code, result.out).toBe(2);
      expect(result.out).toContain(`R0 deletes: ${kept} still exists`);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  }, 60_000);

  it('after R0 is on main: a clean tree passes with currentSlice R0 (merged deletes are history)', () => {
    const repo = makeRepo(true);
    try {
      const result = repo.runIn('--base', 'HEAD');
      expect(result.code, result.out).toBe(0);
      expect(result.out).toContain('Slice R0 exceptions');
      expect(result.out).toContain('Frozen forms OK for slice R0: 0 changed file(s)');
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  }, 60_000);

  it('after R0 is on main: adding R1 and switching to it passes, and R1 is checked with R1 exceptions', () => {
    const repo = makeRepo(true);
    try {
      const head = JSON.parse(JSON.stringify(repo.baseConfig)) as typeof config;
      head.slices.R1 = { note: 'Menu and Settings', allow: ['src/components/ui/tabs.tsx'], deletes: [] };
      head.currentSlice = 'R1';
      repo.writeConfig(head);
      repo.write('src/components/ui/tabs.tsx', '// R1 additive prop\n');
      repo.write('src/views/home-view.tsx', '// R1 screen work\n');
      repo.commit('R1 start');
      const ok = repo.runIn('--base', repo.base);
      expect(ok.code, ok.out).toBe(0);
      expect(ok.out).toContain('Slice R1 exceptions (Menu and Settings):');
      expect(ok.out).toContain('Frozen forms OK for slice R1');

      // An R1 change outside its exceptions is still refused.
      repo.write('src/components/ui/cn.ts', '// not listed\n');
      const bad = repo.runIn('--base', repo.base);
      expect(bad.code, bad.out).toBe(1);
      expect(bad.out).toContain('crm/src/components/ui/cn.ts');
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  }, 60_000);

  it('after R0 is on main: editing the R0 entry (or the guard script) is refused, even though R0 listed them', () => {
    const repo = makeRepo(true);
    try {
      const head = JSON.parse(JSON.stringify(repo.baseConfig)) as typeof config;
      head.slices.R0!.allow = [...(head.slices.R0!.allow ?? []), 'src/components/ui/cn.ts'];
      repo.writeConfig(head);
      repo.write('src/components/ui/cn.ts', '// sneaked in\n');
      repo.commit('widen R0');
      const result = repo.runIn('--base', repo.base);
      expect(result.code, result.out).toBe(1);
      expect(result.out).toContain('crm/scripts/ci/frozen-forms.json');
      expect(result.out).toContain('slice R0 changed (only new slices may be added)');

      const script = readFileSync(join(repo.root, 'crm/scripts/ci/check-frozen-forms.mjs'), 'utf8');
      const head2 = JSON.parse(JSON.stringify(repo.baseConfig)) as typeof config;
      head2.slices.R1 = { allow: [], deletes: [] };
      head2.currentSlice = 'R1';
      repo.writeConfig(head2);
      repo.write('src/components/ui/cn.ts', '// cn.ts\n');
      repo.write('scripts/ci/check-frozen-forms.mjs', `${script}// weakened\n`);
      const guard = repo.runIn('--base', repo.base);
      expect(guard.code, guard.out).toBe(1);
      expect(guard.out).toContain('crm/scripts/ci/check-frozen-forms.mjs');
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  }, 60_000);
});
