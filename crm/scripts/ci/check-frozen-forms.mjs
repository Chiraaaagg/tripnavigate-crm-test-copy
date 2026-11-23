#!/usr/bin/env node
// CI: the owner-approved forms stay frozen (UX redesign build plan 4.3).
// Usage (from anywhere): node crm/scripts/ci/check-frozen-forms.mjs [--slice R1] [--base <ref>] [--files a b ...]
//
// Lists the files a change touches (added, edited or deleted; a rename counts
// as both paths) and fails when one of them is frozen (scripts/ci/frozen-forms.json:
// the approved forms, the shared parts and stylesheets they import, and this
// guard itself) and is not an exception of the slice:
//   allow    the slice may add or edit the file;
//   deletes  the slice may only delete the file (gone from the working tree;
//            once the slice is merged the base lacks it too and the entry is history).
// frozen-forms.json itself, once the base has it, may only set currentSlice,
// add new slice entries and add paths to the frozen lists (frozen,
// importedByForms, guard); existing slices, removals and other keys are refused.
// The run prints the slice's exceptions first, so they show in the CI log.
// --slice defaults to "currentSlice" in frozen-forms.json.
// --base is the commit the change is measured from. Default: origin/main when
// this clone has it (CI fetches it first), else main. When the base and HEAD
// share history the change is <base>...HEAD (only this branch's commits); in a
// shallow clone without a common commit it is <base>..HEAD (CI checks out the
// pull request merged into main, so that is exactly the pull request).
// Uncommitted edits and new untracked files are always included.
// A branch stacked on an unmerged slice branch passes that branch as --base,
// e.g. an R2 branch built on R1: --slice R2 --base claude/ux-r1-menu, so only
// the R2 commits are held to the R2 exceptions.
// --files checks an explicit list instead of git (repository-root or crm paths).
// Exits 1 and lists every refused file; 2 on a usage or configuration error; 0 when clean.
// The pure helpers are exported for crm/tests/unit/check-frozen-forms.test.ts.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CRM = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const CONFIG_PATH = resolve(CRM, 'scripts/ci/frozen-forms.json');

export function loadConfig(path = CONFIG_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** "src/views/b11/**" -> RegExp. '**' any depth (also none), '*' within one folder; everything else literal. */
export function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i += 1;
      if (glob[i + 1] === '/') {
        i += 1;
        out += '(?:.*/)?';
      } else {
        out += '.*';
      }
    } else if (c === '*') {
      out += '[^/]*';
    } else {
      out += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

/** Repository-root or crm-relative path, any slashes -> crm-relative with forward slashes. */
export function normalisePath(path) {
  return String(path).trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^crm\//, '');
}

const matchesAny = (path, globs) => globs.some((g) => globToRegExp(normalisePath(g)).test(path));

/** Every frozen pattern: the forms, what they import, and the guard. */
export function frozenPatterns(config) {
  return [...(config.frozen ?? []), ...(config.importedByForms ?? []), ...(config.guard ?? [])];
}

export function isFrozen(path, config) {
  const p = normalisePath(path);
  return matchesAny(p, frozenPatterns(config)) && !matchesAny(p, config.notFrozen ?? []);
}

function sliceEntry(config, slice) {
  const entry = config.slices?.[slice];
  if (!entry) throw new Error(`Unknown slice "${slice}". Known slices: ${Object.keys(config.slices ?? {}).join(', ')}.`);
  return entry;
}

/**
 * The refused files of a change: frozen, and neither an `allow` exception nor a
 * `deletes` exception that is really deleted. `isDeleted(path)` says whether the
 * change removed the file. Throws for an unknown slice, so a typo never passes.
 */
export function checkFrozen(changedPaths, config, slice, isDeleted = () => false) {
  const entry = sliceEntry(config, slice);
  const allow = (entry.allow ?? []).map(normalisePath);
  const deletes = (entry.deletes ?? []).map(normalisePath);
  const seen = new Set();
  const refused = [];
  for (const raw of changedPaths) {
    const p = normalisePath(raw);
    if (!p || seen.has(p)) continue;
    seen.add(p);
    if (!isFrozen(p, config)) continue;
    if (matchesAny(p, allow)) continue;
    if (matchesAny(p, deletes) && isDeleted(p)) continue;
    refused.push(p);
  }
  return refused.sort();
}

/**
 * Configuration problems of one slice: an exception that is not frozen (a
 * typo), an `allow` file that does not exist now, or a `deletes` file that
 * still exists now. A listed delete that is missing now is fine whether or not
 * the base has it: missing at the base too means the slice is already merged
 * (its entry is history).
 */
export function sliceProblems(config, slice, existsNow) {
  const entry = sliceEntry(config, slice);
  const problems = [];
  for (const raw of entry.allow ?? []) {
    const p = normalisePath(raw);
    if (!isFrozen(p, config)) problems.push(`${slice} allow: ${p} is not frozen (typo?)`);
    if (!p.includes('*') && !existsNow(p)) problems.push(`${slice} allow: ${p} does not exist`);
  }
  for (const raw of entry.deletes ?? []) {
    const p = normalisePath(raw);
    if (!isFrozen(p, config)) problems.push(`${slice} deletes: ${p} is not frozen (typo?)`);
    if (existsNow(p)) problems.push(`${slice} deletes: ${p} still exists`);
  }
  return problems;
}

/** frozen-forms.json, crm-relative. */
export const CONFIG_REL = 'scripts/ci/frozen-forms.json';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Owner decision 18 November 2026: these lists may only grow. Adding a path
// freezes more; removing one is refused.
const GROW_ONLY_KEYS = ['frozen', 'importedByForms', 'guard'];

/**
 * How frozen-forms.json may change once it exists at the base: `currentSlice`
 * may be set, new slice entries may be added, and paths may be added to the
 * frozen lists (never removed). Returns one line per other difference (an
 * empty list = the change is allowed).
 */
export function configChangeProblems(baseConfig, headConfig) {
  const problems = [];
  const keys = new Set([...Object.keys(baseConfig), ...Object.keys(headConfig)]);
  for (const key of [...keys].sort()) {
    if (key === 'currentSlice' || key === 'slices') continue;
    if (GROW_ONLY_KEYS.includes(key) && Array.isArray(baseConfig[key]) && Array.isArray(headConfig[key])) {
      const head = new Set(headConfig[key]);
      const removed = baseConfig[key].filter((p) => !head.has(p));
      if (removed.length > 0) problems.push(`"${key}" lost ${removed.join(', ')} (frozen lists may only grow)`);
      continue;
    }
    if (!same(baseConfig[key], headConfig[key])) problems.push(`"${key}" changed`);
  }
  if (headConfig.currentSlice && !headConfig.slices?.[headConfig.currentSlice]) problems.push(`currentSlice "${headConfig.currentSlice}" has no slice entry`);
  for (const [slice, entry] of Object.entries(baseConfig.slices ?? {})) {
    if (!headConfig.slices || !(slice in headConfig.slices)) problems.push(`slice ${slice} removed`);
    else if (!same(entry, headConfig.slices[slice])) problems.push(`slice ${slice} changed (only new slices may be added)`);
  }
  return problems;
}

/**
 * The final verdict on frozen-forms.json when the base has it: the change
 * rule above replaces the allow lists for this one file (an existing slice can
 * never allow-list a change to itself).
 */
export function applyConfigRule(refused, changedPaths, baseConfig, headConfig) {
  const touched = changedPaths.map(normalisePath).includes(CONFIG_REL);
  if (!baseConfig || !touched) return refused;
  const rest = refused.filter((p) => p !== CONFIG_REL);
  return configChangeProblems(baseConfig, headConfig).length === 0 ? rest : [...rest, CONFIG_REL].sort();
}

/** Lines for the log: the slice's exceptions, so a reviewer sees them in CI. */
export function exceptionLines(config, slice) {
  const entry = sliceEntry(config, slice);
  const list = (xs) => (xs && xs.length ? xs.map((x) => `    crm/${normalisePath(x)}`) : ['    (none)']);
  return [`Slice ${slice} exceptions${entry.note ? ` (${entry.note})` : ''}:`, '  allow:', ...list(entry.allow), '  deletes:', ...list(entry.deletes)];
}

const gitIn = (cwd) => (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const gitOk = (cwd, ...args) => {
  try {
    gitIn(cwd)(...args);
    return true;
  } catch {
    return false;
  }
};

/** The repository root (crm/ sits inside it). */
export function repoRoot(cwd = CRM) {
  return gitIn(cwd)('rev-parse', '--show-toplevel').trim();
}

/** origin/main when this clone has it, else main. */
export function defaultBase(cwd = CRM) {
  return gitOk(cwd, 'rev-parse', '--verify', '--quiet', 'origin/main') ? 'origin/main' : 'main';
}

/** <base>...HEAD when they share history, else <base>..HEAD (shallow CI clone of a pull request merge). */
export function diffRange(base, cwd = CRM) {
  return gitOk(cwd, 'merge-base', base, 'HEAD') ? `${base}...HEAD` : `${base}..HEAD`;
}

/** The commit the change starts from: the merge base with HEAD, else the base itself. */
export function startCommit(base, cwd = CRM) {
  try {
    return gitIn(cwd)('merge-base', base, 'HEAD').trim();
  } catch {
    return gitIn(cwd)('rev-parse', '--verify', base).trim();
  }
}

/** crm-relative paths a change touches (see the header). Only paths under crm/ are returned. */
export function changedFiles(base, cwd = CRM) {
  const run = (...args) => gitIn(repoRoot(cwd))(...args).split('\n').filter(Boolean);
  const files = [
    ...run('diff', '--name-only', '--no-renames', diffRange(base, cwd)),
    ...run('diff', '--name-only', '--no-renames', 'HEAD'),
    ...run('ls-files', '--others', '--exclude-standard'),
  ];
  return [...new Set(files.filter((f) => f.startsWith('crm/')).map(normalisePath))];
}

/** Whether a crm-relative path exists in a commit (git cat-file -e <commit>:crm/<path>). */
export function existsInCommit(commit, path, cwd = CRM) {
  return gitOk(repoRoot(cwd), 'cat-file', '-e', `${commit}:crm/${normalisePath(path)}`);
}

/** A crm-relative file's text in a commit, or null when the commit does not have it. */
export function readInCommit(commit, path, cwd = CRM) {
  try {
    return gitIn(repoRoot(cwd))('show', `${commit}:crm/${normalisePath(path)}`);
  } catch {
    return null;
  }
}

/** Whether a crm-relative path exists in the working tree. */
export function existsNow(path) {
  return existsSync(resolve(CRM, normalisePath(path)));
}

export function parseArgs(argv) {
  const args = { slice: null, base: null, files: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--slice' || a === '--base') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`Give a value after ${a}.`);
      args[a.slice(2)] = value;
      i += 1;
    } else if (a === '--files') {
      args.files = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) args.files.push(argv[(i += 1)]);
    } else throw new Error(`Unknown option ${a}`);
  }
  return args;
}

function main() {
  let args;
  let config;
  try {
    args = parseArgs(process.argv.slice(2));
    config = loadConfig();
    args.slice ??= config.currentSlice ?? null;
    if (!args.slice) throw new Error('No --slice given and no currentSlice in frozen-forms.json.');
    sliceEntry(config, args.slice);
  } catch (e) {
    console.error(String(e.message ?? e));
    process.exit(2);
  }

  for (const line of exceptionLines(config, args.slice)) console.log(line);

  let files;
  let isDeleted;
  let where;
  let baseConfig = null;
  if (args.files) {
    files = args.files.map(normalisePath);
    isDeleted = (p) => !existsNow(p);
    where = 'given on the command line';
  } else {
    const base = args.base ?? defaultBase();
    let start;
    try {
      start = startCommit(base);
      files = changedFiles(base);
    } catch (e) {
      console.error(`Cannot read the change against ${base}: ${String(e.message ?? e).split('\n')[0]}`);
      process.exit(2);
    }
    isDeleted = (p) => !existsNow(p) && existsInCommit(start, p);
    const baseText = readInCommit(start, CONFIG_REL);
    if (baseText !== null) {
      try {
        baseConfig = JSON.parse(baseText);
      } catch {
        baseConfig = {};
      }
    }
    where = `against ${base} (${diffRange(base)})`;
  }

  const problems = sliceProblems(config, args.slice, existsNow);
  if (problems.length > 0) {
    console.error(`frozen-forms.json has ${problems.length} problem(s) for slice ${args.slice}:`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(2);
  }

  const refused = applyConfigRule(checkFrozen(files, config, args.slice, isDeleted), files, baseConfig, config);
  if (refused.length > 0) {
    console.error(`Frozen approved-form files changed outside slice ${args.slice}'s exceptions (${refused.length}):`);
    for (const f of refused) console.error(`  crm/${f}`);
    if (baseConfig && refused.includes(CONFIG_REL)) {
      console.error('frozen-forms.json may only set currentSlice and add new slices. Other changes:');
      for (const p of configChangeProblems(baseConfig, config)) console.error(`  ${p}`);
    }
    console.error('These forms are owner-approved. Undo the change, or ask the lead for an owner-approved exception in a new slice entry of scripts/ci/frozen-forms.json.');
    process.exit(1);
  }
  console.log(`Frozen forms OK for slice ${args.slice}: ${files.length} changed file(s) checked ${where}.`);
}

// Run only when executed directly, not when imported by the unit test.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main();
}
