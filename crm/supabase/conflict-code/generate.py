#!/usr/bin/env python3
"""Booking reliability B1-1: generates the conflict-code migrations
(supabase/migrations/20261206000100, 000110, 000200, 000210), the function
list (functions.tsv), the live pre-check (precheck.sql) and the rollback files
from the newest definition of every function in the migration history up to
20261205000800. Run from crm/: python3 supabase/conflict-code/generate.py
Re-running it on the same history reproduces the files byte for byte.
Not run by CI; tests/db/br-conflict-code.test.ts checks the result.
"""
import re, glob, os, sys, hashlib

os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))

MIG = 'supabase/migrations'
UPTO = '20261205999999'  # the last migration before B1-1

def stmt_end(s, i):
    """Scan from i to the end of the SQL statement (top-level ';'). Returns index after ';'."""
    n = len(s)
    while i < n:
        c = s[i]
        if c == "'":
            j = i + 1
            while True:
                k = s.index("'", j)
                if k + 1 < n and s[k + 1] == "'":
                    j = k + 2; continue
                i = k + 1; break
            continue
        if c == '-' and s.startswith('--', i):
            i = s.find('\n', i); i = n if i < 0 else i; continue
        if c == '/' and s.startswith('/*', i):
            i = s.index('*/', i) + 2; continue
        if c == '$':
            m = re.compile(r'\$([A-Za-z_][A-Za-z0-9_]*)?\$').match(s, i)
            if m:
                tag = m.group(0)
                k = s.index(tag, m.end())
                i = k + len(tag); continue
        if c == ';':
            return i + 1
        i += 1
    return n

def split_top(s):
    parts, depth, cur, i = [], 0, '', 0
    while i < len(s):
        c = s[i]
        if c == "'":
            k = s.index("'", i + 1); cur += s[i:k + 1]; i = k + 1; continue
        if c == '(':
            depth += 1
        elif c == ')':
            depth -= 1
        elif c == ',' and depth == 0:
            parts.append(cur); cur = ''; i += 1; continue
        cur += c; i += 1
    if cur.strip(): parts.append(cur)
    return parts

TYPEWORDS = None
def norm_types(params, is_create):
    out = []
    for p in split_top(params):
        p = re.sub(r'--[^\n]*', '', p)
        p = ' '.join(p.split()).lower()
        p = re.split(r'\s+default\s+|\s*=\s*', p)[0]
        toks = p.split(' ')
        mode = 'in'
        if toks[0] in ('in', 'out', 'inout', 'variadic'):
            mode = toks[0]; toks = toks[1:]
        if mode == 'out':
            continue
        if is_create and len(toks) >= 2:
            # first token is a name unless the type is multiword without a name; assume names present
            toks = toks[1:]
        elif not is_create and len(toks) >= 2:
            # drop signature may include names; heuristic: if first token is not a known type start
            if not re.match(r'^(public\.|authz\.|text|int|integer|bigint|smallint|uuid|boolean|bool|jsonb|json|numeric|date|timestamptz|timestamp|double|character|varchar|real|bytea|inet|interval|time|char)', toks[0]):
                toks = toks[1:]
        t = ' '.join(toks)
        t = t.replace('int4', 'integer').replace('int8', 'bigint').replace('bool ', 'boolean ')
        t = re.sub(r'^int$', 'integer', t)
        t = re.sub(r'^int\[\]$', 'integer[]', t)
        t = re.sub(r'^bool$', 'boolean', t)
        t = re.sub(r'^timestamp with time zone$', 'timestamptz', t)
        t = re.sub(r'^character varying', 'varchar', t)
        out.append(t)
    return tuple(out)

CREATE = re.compile(r'\bcreate\s+(?:or\s+replace\s+)?function\s+("?[a-z_]+"?)\.("?[a-z0-9_]+"?)\s*\(', re.I)
DROP = re.compile(r'\bdrop\s+function\s+(?:if\s+exists\s+)?([a-z_]+)\.([a-z0-9_]+)\s*(\(([^;]*?)\))?\s*(?:cascade|restrict)?\s*;', re.I)

def parens(s, i):
    depth = 0; j = i
    while True:
        c = s[j]
        if c == "'":
            j = s.index("'", j + 1)
        elif c == '(':
            depth += 1
        elif c == ')':
            depth -= 1
            if depth == 0: return j
        j += 1

def strip_comments_positions(s):
    return s

def parse():
    funcs = {}  # identity -> dict
    for f in sorted(glob.glob(os.path.join(MIG, '*.sql'))):
        base = os.path.basename(f)
        if base[:14] > UPTO: break
        s = open(f).read()
        events = []
        i = 0
        # walk statements in order, skipping comments/strings correctly
        n = len(s)
        pos = 0
        while pos < n:
            # skip whitespace and comments
            m = re.compile(r'\s+|--[^\n]*\n?|/\*.*?\*/', re.S).match(s, pos)
            if m and m.end() > pos:
                pos = m.end(); continue
            end = stmt_end(s, pos)
            st = s[pos:end]
            mc = CREATE.match(st)
            if mc:
                sch, name = mc.group(1).strip('"'), mc.group(2).strip('"')
                op = mc.end() - 1
                cp = parens(st, op)
                ident = (sch, name, norm_types(st[op + 1:cp], True))
                funcs[ident] = dict(file=base, line=s.count('\n', 0, pos) + 1, text=st, start=pos, end=end)
            else:
                md = DROP.match(st)
                if md:
                    sch, name = md.group(1), md.group(2)
                    if md.group(3) is None:
                        for k in [k for k in funcs if k[0] == sch and k[1] == name]:
                            del funcs[k]
                    else:
                        ident = (sch, name, norm_types(md.group(4) or '', False))
                        if ident in funcs: del funcs[ident]
                        else:
                            cands = [k for k in funcs if k[0] == sch and k[1] == name]
                            print('WARN drop not matched', base, ident, cands, file=sys.stderr)
            pos = end
    return funcs


funcs = parse()

LIT = re.compile(r"'40001'")
HANDLER = re.compile(r"sqlstate\s+'40001'", re.I)
RAISE = re.compile(r"errcode\s*=\s*'40001'")

def body(t):
    m = re.search(r'\$([A-Za-z_][A-Za-z0-9_]*)?\$', t)
    tag = m.group(0); e = t.index(tag, m.end())
    return t[m.end():e]

def restate(t):
    t2, n = re.subn(r'^create\s+(?:or\s+replace\s+)?function\b', 'create or replace function', t, count=1, flags=re.I)
    assert n == 1, t[:80]
    return t2

sel = {k: v for k, v in funcs.items() if k[0] in ('public', 'authz') and LIT.search(v['text'])}
assert len(sel) == 108, len(sel)
for k, v in sel.items():
    t = v['text']
    total = len(LIT.findall(t)); h = len(HANDLER.findall(t)); r = len(RAISE.findall(t))
    assert total == h + r, (k, total, h, r)

RRV = ('authz', 'require_row_version', ('integer', 'integer'))
handlers = sorted(k for k, v in sel.items() if HANDLER.search(v['text']))
assert len(handlers) == 7, handlers
rest = sorted(k for k in sel if k != RRV and k not in handlers)
assert len(rest) == 100, len(rest)

def sig(k):
    return f"{k[0]}.{k[1]}({', '.join(k[2])})"

def stage1_handler(t):
    return HANDLER.sub("sqlstate '40001' or sqlstate 'PT409'", t)

def final_handler(t):
    t = HANDLER.sub("sqlstate 'PT409'", t)
    return RAISE.sub("errcode = 'PT409'", t)

def stage2(t):
    return RAISE.sub("errcode = 'PT409'", t)

def rrv(t):
    return RAISE.sub("errcode = 'PT409'", t)

COMMON = """--
-- Booking reliability fix, item B1-1 (build contract section 6, B1-1; addendum 2, gate G0).
-- PostgREST 14 treats SQLSTATE 40001 as a serialization failure and re-runs the
-- whole request without end after the client has gone. Business refusals
-- ("someone changed this", "duplicate request", ...) therefore move from 40001
-- to PT409: PostgREST's custom-status prefix, answered once as HTTP 409, with
-- code, message and hint intact (proved on PostgREST 14.18 by gate G0). The app
-- accepts both codes before this runs (src/lib/sqlstate.ts).
--
-- How this file was made: every function below is restated from its newest
-- definition in the migration history (source file named next to it), with
-- only the code literal changed. "create function" becomes "create or replace
-- function"; the body, the argument list, the return type, language,
-- volatility, security definer and set search_path are restated exactly as
-- written there. Owner, grants and comments are kept by create or replace.
-- Message tokens, hints and every condition that raises stay as they are.
-- tests/db/br-conflict-code.test.ts compares each function before and after
-- (definition with the literal put back, security definer, configuration,
-- volatility, grants, owner) and fails on any other difference.
-- Function list and live pre-check: supabase/conflict-code/.
"""

def migration(name, title, items, transform, extra=''):
    out = [f"-- TripNavigate CRM - {title}", COMMON, extra,
           "-- Replaces (newest definition, source migration):"]
    for k in items:
        v = sel[k]
        out.append(f"--   {sig(k)}  ({v['file']})")
    out.append("")
    out.append("begin;")
    out.append("")
    for k in items:
        v = sel[k]
        new = transform(restate(v['text']))
        assert new != restate(v['text']), k
        out.append(f"-- {sig(k)}: from {v['file']}")
        out.append(new)
        out.append("")
    out.append("commit;")
    out.append("")
    open(f'supabase/migrations/{name}', 'w').write('\n'.join(out))

migration('20261206000100_conflict_code_handlers.sql',
          'B1-1 stage 1a: the conflict handlers accept 40001 or PT409',
          handlers, stage1_handler,
          """-- Stage 1a. The seven exception handlers that catch a conflict refusal
-- (six replay/remember wrappers and the automatic bill release) now catch
-- 40001 or PT409, so they keep working while functions move to PT409. What
-- they raise themselves is unchanged here (stage 2, 20261206000210).
-- The contract counted nine handler sites; two of them (20261205000210 line
-- 575 and 20261205000260 line 197) are older definitions of
-- authz.cdoc_auto_run_inner, replaced by 20261205000270, so seven remain.
""")
migration('20261206000110_conflict_code_row_version.sql',
          'B1-1 stage 1b: authz.require_row_version raises PT409',
          [RRV], rrv,
          """-- Stage 1b. authz.require_row_version (called by 88 save functions) raises
-- version_changed with PT409 instead of 40001. This is the proven looper.
""")
migration('20261206000200_conflict_code_all.sql',
          'B1-1 stage 2a: every remaining business refusal raises PT409',
          rest, stage2,
          """-- Stage 2a. Every remaining function in public and authz that raised a
-- business refusal with 40001 now raises it with PT409 (100 functions).
""")
migration('20261206000210_conflict_code_handlers_final.sql',
          'B1-1 stage 2b: the conflict handlers catch and raise PT409 only',
          handlers, final_handler,
          """-- Stage 2b. After 20261206000200 nothing raises 40001 any more. The seven
-- handlers now catch PT409 only, and the replay/remember wrappers raise
-- duplicate_request with PT409. Afterwards no function in public or authz
-- contains a class-40 SQLSTATE (tests/db/br-no-class40.test.ts).
""")

# List with md5 of the body (pg_proc.prosrc) before each stage.
os.makedirs('supabase/conflict-code', exist_ok=True)
rows = ["schema\tname\tidentity_arguments\tstage\tsource_migration\tprosrc_md5_before"]
for k in handlers:
    rows.append(f"{k[0]}\t{k[1]}\t{', '.join(k[2])}\thandler\t{sel[k]['file']}\t{hashlib.md5(body(sel[k]['text']).encode()).hexdigest()}")
rows.append(f"{RRV[0]}\t{RRV[1]}\t{', '.join(RRV[2])}\t1\t{sel[RRV]['file']}\t{hashlib.md5(body(sel[RRV]['text']).encode()).hexdigest()}")
for k in rest:
    rows.append(f"{k[0]}\t{k[1]}\t{', '.join(k[2])}\t2\t{sel[k]['file']}\t{hashlib.md5(body(sel[k]['text']).encode()).hexdigest()}")
open('supabase/conflict-code/functions.tsv', 'w').write('\n'.join(rows) + '\n')

# Rollback files (not migrations; applied only by an approved fix-forward).
def rollback(name, title, items, transform_before):
    out = [f"-- ROLLBACK ONLY - not a migration. {title}",
           "-- Restores the function text that was live before the named migration.",
           "-- Apply only with the owner's approval, as a fix-forward migration copied",
           "-- into the lead's spare range (20261206000900-990). Generated with the",
           "-- migrations in supabase/migrations/20261206000*_conflict_code_*.sql.",
           "", "begin;", ""]
    for k in items:
        out.append(f"-- {sig(k)}")
        out.append(transform_before(restate(sel[k]['text'])))
        out.append("")
    out += ["commit;", ""]
    open(f'supabase/conflict-code/{name}', 'w').write('\n'.join(out))

rollback('rollback-stage2.sql', 'Undo stage 2 (20261206000200 and 20261206000210).',
         handlers + rest, lambda t: stage1_handler(t) if HANDLER.search(t) else t)
rollback('rollback-stage1.sql', 'Undo stage 1b (20261206000110): require_row_version raises 40001 again. The handlers may keep accepting both codes.',
         [RRV], lambda t: t)
print('ok', len(handlers), 1, len(rest))

# Live pre-check (read-only): every listed function's body must equal the
# body these migrations were made from. Any row returned = stop the release.
allk = [(k, 'handler') for k in handlers] + [(RRV, '1')] + [(k, '2') for k in rest]
vals = ',\n'.join(f"    ('{k[0]}', '{k[1]}', '{hashlib.md5(body(sel[k]['text']).encode()).hexdigest()}')" for k, _ in allk)
pre = f"""-- READ-ONLY live pre-check for the B1-1 conflict-code migrations
-- (20261206000100, 000110, 000200, 000210). Run before each go-live step
-- that applies them (build contract B1-1, "Before each release").
--
-- Expected result: NO ROWS. Any row means the live function differs from the
-- definition the migrations were generated from (or is missing, or has an
-- overload): stop the release and report it. The expected md5 values are
-- md5(pg_proc.prosrc) of the newest definition in the migration history;
-- tests/db/br-conflict-code.test.ts proves on CI that a database built from
-- the migrations has exactly these values.
--
-- Before stage 1 every listed function is expected as below. Between stage 1
-- and stage 2, rerun with only the rows of stage '2' (the stage-1 functions
-- have changed by then, as intended).
--
-- How the list was made (on a database built from the migrations up to
-- 20261205000800; it returns the same {len(allk)} functions):
--   select n.nspname, p.proname
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname in ('public', 'authz') and p.prosrc ~ '''40001'''
--   order by 1, 2;
-- (A plain "like '%40001%'" also matches migration numbers such as
-- 20261204000110 in comments: that is why 123 was counted on live, not {len(allk)}.)

with expected(nspname, proname, body_md5) as (
  values
{vals}
),
live as (
  select n.nspname, p.proname, md5(p.prosrc) as body_md5, count(*) over (partition by n.nspname, p.proname) as overloads
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'authz')
)
select e.nspname, e.proname, e.body_md5 as expected_md5, l.body_md5 as live_md5, l.overloads,
       case when l.proname is null then 'missing' when l.overloads > 1 then 'overloaded' else 'different' end as problem
from expected e
left join live l on l.nspname = e.nspname and l.proname = e.proname
where l.proname is null or l.overloads > 1 or l.body_md5 <> e.body_md5
union all
-- A function that contains 40001 on live but is not in the list.
select n.nspname, p.proname, null, md5(p.prosrc), 1, 'not in list'
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('public', 'authz') and p.prosrc ~ '''40001'''
  and not exists (select 1 from expected e where e.nspname = n.nspname and e.proname = p.proname)
order by 1, 2;
"""
open('supabase/conflict-code/precheck.sql', 'w').write(pre)
