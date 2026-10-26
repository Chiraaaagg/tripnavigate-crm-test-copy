#!/usr/bin/env node
// CI: relative links in Markdown files must point at files that exist.
// Usage (from anywhere): node crm/scripts/ci/check-doc-links.mjs
// Scans every *.md file in the repository (skipping node_modules, _archive,
// .git, .next and other build output) and checks each relative link target:
// inline links and images [text](target), and reference definitions
// [id]: target whose target looks like a path (contains / or .md, or starts
// with ./ ../ or #); footnotes [^id]: are not links. External links (http:,
// https:, mailto: and other schemes) and same-file anchors (#section) are
// skipped. For a link such as file.md#section only the file is checked, not
// the anchor. Links inside code are ignored: fenced code blocks at any
// indentation, indented code blocks (also inside list items) and inline code.
// Exits 1 and lists every broken link; exits 0 when all links resolve.
// The pure helpers are exported for crm/tests/unit/check-doc-links.test.ts.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SKIP_DIRS = new Set([
  'node_modules',
  '_archive',
  '.git',
  '.next',
  '.vercel',
  '.turbo',
  'coverage',
  'playwright-report',
  'test-results',
]);

function findMarkdown(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) findMarkdown(join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

// Replace inline code spans with spaces so their contents are not parsed as
// links, keeping column positions stable.
export function stripInlineCode(line) {
  return line.replace(/(`+)([\s\S]*?)\1/g, (m) => ' '.repeat(m.length));
}

// Extract link targets from one line: [text](target "title") and
// ![alt](target). Parentheses inside the target are balanced.
export function inlineTargets(line) {
  const targets = [];
  let i = 0;
  while ((i = line.indexOf('](', i)) !== -1) {
    let j = i + 2;
    let depth = 1;
    let raw = '';
    if (line[j] === '<') {
      const end = line.indexOf('>', j);
      if (end === -1) {
        i = j;
        continue;
      }
      raw = line.slice(j + 1, end);
      targets.push(raw);
      i = end;
      continue;
    }
    while (j < line.length && depth > 0) {
      const c = line[j];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      if (depth > 0) raw += c;
      j++;
    }
    if (depth === 0) {
      // Drop an optional title: target "title" / target 'title'.
      targets.push(raw.trim().split(/\s+/)[0] ?? '');
    }
    i = j;
  }
  return targets;
}

// A reference definition [id]: target. Footnote definitions [^id]: text are
// skipped, and so are definitions whose target does not look like a path
// (for example "[Note]: see below"), which are ordinary text.
export function referenceTarget(line) {
  const m = /^\s{0,3}\[(?!\^)[^\]]+\]:\s*<?([^\s>]+)>?/.exec(line);
  if (!m) return undefined;
  const target = m[1];
  const pathShaped =
    target.includes('/') ||
    /\.md(?:[#?]|$)/i.test(target) ||
    target.startsWith('./') ||
    target.startsWith('../') ||
    target.startsWith('#');
  return pathShaped ? target : undefined;
}

export function isExternal(target) {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//');
}

function checkTarget(file, target) {
  if (!target || target.startsWith('#') || isExternal(target)) return true;
  let path = target.split('#')[0].split('?')[0];
  if (!path) return true;
  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep the raw path when it is not valid percent-encoding.
  }
  const abs = path.startsWith('/') ? join(ROOT, path) : resolve(dirname(file), path);
  return existsSync(abs);
}

// Width of the leading whitespace, with tabs advancing to the next multiple
// of 4 columns.
function leadingWidth(line) {
  let width = 0;
  for (const c of line) {
    if (c === ' ') width += 1;
    else if (c === '\t') width += 4 - (width % 4);
    else break;
  }
  return width;
}

// Returns, for each line, whether it is code (a fence line, inside a fenced
// block at any indentation, or an indented code block, including one inside a
// list item). Simplified CommonMark: an indented code block starts after a
// blank line (it cannot interrupt a paragraph) and is indented at least 4
// columns past the content of the list item it sits in.
export function codeLines(lines) {
  const code = new Array(lines.length).fill(false);
  let fence = null;
  let prevBlank = true;
  let inIndented = false;
  const listIndents = [];
  lines.forEach((line, index) => {
    if (fence !== null) {
      code[index] = true;
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      return;
    }
    if (line.trim() === '') {
      prevBlank = true;
      if (inIndented) code[index] = true;
      return;
    }
    const indent = leadingWidth(line);
    if (prevBlank) {
      while (listIndents.length > 0 && indent < listIndents[listIndents.length - 1]) {
        listIndents.pop();
      }
    }
    // A fence opens a code block at any indentation (also when it would
    // otherwise be indented code), so its contents are always skipped.
    const open = /^\s*(`{3,}|~{3,})/.exec(line);
    if (open) {
      code[index] = true;
      fence = open[1];
      inIndented = false;
      prevBlank = false;
      return;
    }
    const base = listIndents.length > 0 ? listIndents[listIndents.length - 1] : 0;
    if ((prevBlank || inIndented) && indent >= base + 4) {
      code[index] = true;
      inIndented = true;
      prevBlank = false;
      return;
    }
    inIndented = false;
    prevBlank = false;
    const item = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)\S/.exec(line);
    if (item) {
      const markerStart = leadingWidth(item[1]);
      while (listIndents.length > 0 && listIndents[listIndents.length - 1] > markerStart) {
        listIndents.pop();
      }
      const gap = item[3].length > 4 ? 1 : item[3].length;
      listIndents.push(markerStart + item[2].length + gap);
    }
  });
  return code;
}

// Every link target in one Markdown text, with its 1-based line number.
export function markdownTargets(text) {
  const lines = text.split(/\r?\n/);
  const code = codeLines(lines);
  const found = [];
  lines.forEach((rawLine, index) => {
    if (code[index]) return;
    const line = stripInlineCode(rawLine);
    const targets = inlineTargets(line);
    const ref = referenceTarget(line);
    if (ref) targets.push(ref);
    for (const target of targets) found.push({ line: index + 1, target });
  });
  return found;
}

function main() {
  const broken = [];
  const files = findMarkdown(ROOT).sort();
  for (const file of files) {
    for (const { line, target } of markdownTargets(readFileSync(file, 'utf8'))) {
      if (!checkTarget(file, target)) {
        broken.push(`${relative(ROOT, file).split(sep).join('/')}:${line}: ${target}`);
      }
    }
  }

  if (broken.length > 0) {
    console.error(`Broken relative links in Markdown files (${broken.length}):`);
    for (const line of broken) console.error(`  ${line}`);
    process.exit(1);
  }
  console.log(`Markdown links OK: ${files.length} files checked.`);
}

// Run only when executed directly, not when imported by the unit test. Node
// resolves symlinks for the main module, so compare real paths.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main();
}
