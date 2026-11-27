import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/*
 * Security review go-live 1, P2-1. Since booking reliability B1-8 the proxy
 * lets a signed-out server action POST under /app through to the action, so
 * the action's own first-line gate is the only barrier for signed-out calls.
 * This test reads every 'use server' file in src (the local preview gallery
 * excluded) and fails when an exported action does anything before its gate.
 *
 * Accepted first statements:
 *   - `await requireStaff()` (alone, or as a declaration's initializer);
 *   - `await requireSignedIn()` (the same forms);
 *   - `const x = await staffForAction()` followed at once by
 *     `if (x === SESSION_ENDED) return …`;
 *   - a hand-over `return f(…)` / `const y = await f(…)` to a function of the
 *     same file whose own first statement passes these rules, with only inert
 *     arguments (names, literals, property reads; no calls).
 * Anything else must be on ALLOW below, which holds only the actions meant
 * to run before sign-in. Each allowed name must still exist, so the list
 * cannot go stale.
 */

const SRC = fileURLToPath(new URL('../../src', import.meta.url));
const EXCLUDED_DIR = join(SRC, 'app', 'preview');

/** Actions that run before full sign-in on purpose (served from pages outside /app). */
const ALLOW: Record<string, readonly string[]> = {
  'modules/identity/server/actions.ts': ['signInAction', 'signOutAction', 'requestPasswordResetAction'],
};

const PLAIN_GATES = new Set(['requireStaff', 'requireSignedIn']);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (path !== EXCLUDED_DIR && entry.name !== 'node_modules') out.push(...walk(path));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

function isUseServer(source: ts.SourceFile): boolean {
  const first = source.statements[0];
  return !!first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === 'use server';
}

type Fn = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

function hasExport(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/** The awaited call's callee name of `await f(…)`, or of `f(…)` when `allowBare`. */
function calleeOf(expr: ts.Expression | undefined, allowBare: boolean): { name: string; call: ts.CallExpression } | null {
  if (!expr) return null;
  let e = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isAwaitExpression(e)) e = e.expression;
  else if (!allowBare) return null;
  if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression)) return null;
  return { name: e.expression.text, call: e };
}

/** Names, literals, property reads and literal containers of those: nothing that runs code. */
function isInert(node: ts.Expression): boolean {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true;
  if (node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (ts.isPropertyAccessExpression(node)) return isInert(node.expression);
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) return isInert(node.expression);
  if (ts.isArrayLiteralExpression(node)) return node.elements.every(isInert);
  return false;
}

/** The call a statement starts with: `await f()`, `const … = await f()`, `return f()` or `return await f()`. */
function leadingCall(stmt: ts.Statement | undefined, allowBareReturn: boolean): { name: string; call: ts.CallExpression; binding: ts.BindingName | null } | null {
  if (!stmt) return null;
  if (ts.isExpressionStatement(stmt)) {
    const c = calleeOf(stmt.expression, false);
    return c ? { ...c, binding: null } : null;
  }
  if (ts.isVariableStatement(stmt) && stmt.declarationList.declarations.length === 1) {
    const d = stmt.declarationList.declarations[0]!;
    const c = calleeOf(d.initializer, false);
    return c ? { ...c, binding: d.name } : null;
  }
  if (ts.isReturnStatement(stmt)) {
    const c = calleeOf(stmt.expression, allowBareReturn);
    return c ? { ...c, binding: null } : null;
  }
  return null;
}

function isSessionEndedReturn(stmt: ts.Statement | undefined, name: string): boolean {
  if (!stmt || !ts.isIfStatement(stmt) || stmt.elseStatement) return false;
  const cond = stmt.expression;
  if (!ts.isBinaryExpression(cond) || cond.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return false;
  const sides = [cond.left, cond.right].map((s) => (ts.isIdentifier(s) ? s.text : null));
  if (!(sides.includes(name) && sides.includes('SESSION_ENDED'))) return false;
  const then = stmt.thenStatement;
  return ts.isReturnStatement(then) || (ts.isBlock(then) && then.statements.length === 1 && ts.isReturnStatement(then.statements[0]!));
}

function bodyStatements(fn: Fn): readonly ts.Statement[] | null {
  if (!fn.body) return null;
  if (ts.isBlock(fn.body)) return fn.body.statements;
  // Arrow with an expression body: treat it as `return <expr>`.
  return [ts.factory.createReturnStatement(fn.body)];
}

/** Why `fn` is not gated first, or null when it is. */
function gateProblem(fn: Fn, locals: ReadonlyMap<string, Fn>, seen: Set<Fn>): string | null {
  if (seen.has(fn)) return 'recursive hand-over';
  seen.add(fn);
  const stmts = bodyStatements(fn);
  if (!stmts || stmts.length === 0) return 'empty body';
  const first = leadingCall(stmts[0], true);
  if (!first) return 'the first statement is not a gate call or a hand-over';
  if (PLAIN_GATES.has(first.name)) return first.call.arguments.length === 0 ? null : `${first.name}() takes no arguments`;
  if (first.name === 'staffForAction') {
    if (!first.binding || !ts.isIdentifier(first.binding)) return 'staffForAction() result must be bound to a name';
    return isSessionEndedReturn(stmts[1], first.binding.text) ? null : 'staffForAction() must be followed at once by `if (x === SESSION_ENDED) return …`';
  }
  const local = locals.get(first.name);
  if (!local) return `first call ${first.name}() is not a gate and not a gated function of this file`;
  if (!first.call.arguments.every(isInert)) return `hand-over ${first.name}(…) computes its arguments before the gate`;
  const inner = gateProblem(local, locals, seen);
  return inner ? `hand-over ${first.name}(): ${inner}` : null;
}

interface Action {
  file: string;
  name: string;
  problem: string | null;
}

function scan(): { actions: Action[]; files: number; unrecognised: string[] } {
  const actions: Action[] = [];
  const unrecognised: string[] = [];
  let files = 0;
  for (const path of walk(SRC)) {
    const text = readFileSync(path, 'utf8');
    if (!text.includes('use server')) continue;
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    if (!isUseServer(source)) continue;
    files += 1;
    const file = relative(SRC, path).split('\\').join('/');
    const locals = new Map<string, Fn>();
    const exported: Array<[string, Fn]> = [];
    for (const stmt of source.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        locals.set(stmt.name.text, stmt);
        if (hasExport(stmt)) exported.push([stmt.name.text, stmt]);
      } else if (ts.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) {
          const init = d.initializer;
          if (ts.isIdentifier(d.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
            locals.set(d.name.text, init);
            if (hasExport(stmt)) exported.push([d.name.text, init]);
          } else if (hasExport(stmt)) {
            unrecognised.push(`${file}: exported value ${d.name.getText(source)} is not a function`);
          }
        }
      } else if (ts.isExportDeclaration(stmt) && !stmt.isTypeOnly) {
        unrecognised.push(`${file}: re-export \`${stmt.getText(source)}\` cannot be checked here`);
      } else if (ts.isExportAssignment(stmt)) {
        unrecognised.push(`${file}: export default cannot be checked here`);
      } else if (hasExport(stmt) && !ts.isInterfaceDeclaration(stmt) && !ts.isTypeAliasDeclaration(stmt)) {
        unrecognised.push(`${file}: unrecognised export ${ts.SyntaxKind[stmt.kind]}`);
      }
    }
    for (const [name, fn] of exported) actions.push({ file, name, problem: gateProblem(fn, locals, new Set()) });
  }
  return { actions, files, unrecognised };
}

const result = scan();

describe("every exported server action gates first (the proxy no longer stops signed-out calls)", () => {
  it('finds the server action files and their actions', () => {
    expect(result.files).toBeGreaterThan(40);
    expect(result.actions.length).toBeGreaterThan(300);
  });

  it('every export of a use-server file is a function the test can read', () => {
    expect(result.unrecognised).toEqual([]);
  });

  it('no action does anything before its gate (outside the pre-sign-in allow-list)', () => {
    const failures = result.actions
      .filter((a) => a.problem !== null && !(ALLOW[a.file] ?? []).includes(a.name))
      .map((a) => `${a.file} ${a.name}: ${a.problem}`);
    expect(failures).toEqual([]);
  });

  it('the allow-list names only actions that exist, in files outside /app', () => {
    for (const [file, names] of Object.entries(ALLOW)) {
      expect(file.startsWith('app/app/')).toBe(false);
      for (const name of names) expect(result.actions.some((a) => a.file === file && a.name === name)).toBe(true);
    }
  });

  it('the Book now actions use staffForAction and every Flight adapter gates before it parses', () => {
    const named = (file: string) => result.actions.filter((a) => a.file === file);
    expect(named('app/app/flight/flight-ui-actions.ts')).toHaveLength(7);
    for (const a of named('app/app/flight/flight-ui-actions.ts')) expect(a.problem).toBeNull();
    expect(named('modules/fulfilment/server/book-form-actions.ts').every((a) => a.problem === null)).toBe(true);
  });

  it('the checker refuses work before the gate (self-test)', () => {
    const check = (code: string) => {
      const sf = ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true);
      const locals = new Map<string, Fn>();
      for (const s of sf.statements) if (ts.isFunctionDeclaration(s) && s.name) locals.set(s.name.text, s);
      return gateProblem(locals.get('a')!, locals, new Set());
    };
    expect(check('async function a(f) { await requireStaff(); return 1; }')).toBeNull();
    expect(check('async function a(f) { const { supabase } = await requireSignedIn(); }')).toBeNull();
    expect(check('async function a(f) { const s = await staffForAction(); if (s === SESSION_ENDED) return fail("session"); }')).toBeNull();
    expect(check('async function a(f) { return g(f, ["x"]); } async function g(f, k) { await requireStaff(); }')).toBeNull();
    expect(check('async function a(f) { const x = JSON.parse(f.get("p")); await requireStaff(); }')).not.toBeNull();
    expect(check('async function a(f) { const s = await staffForAction(); await db(); }')).not.toBeNull();
    expect(check('async function a(f) { return g(parse(f)); } async function g(f) { await requireStaff(); }')).not.toBeNull();
    expect(check('async function a(f) { return g(f); } async function g(f) { await db(); }')).not.toBeNull();
    expect(check('async function a(f) { return imported(f); }')).not.toBeNull();
    expect(check('async function a(f) { requireStaff(); }')).not.toBeNull();
  });
});
