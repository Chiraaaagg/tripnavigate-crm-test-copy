import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createBitrixClient } from '@/modules/integration/bitrix/client';
import { resolveBitrixRestTarget } from '@/modules/integration/bitrix/config';
import { IDENTITY_BOX, createBitrixFileReader, createBitrixFileWriter } from '@/modules/integration/bitrix/file-store';
import {
  ID_PROOF_ITEM_FIELD,
  createBitrixIdProofWriter,
  createFieldFileInspector,
  processIdProofCopyBatch,
  type IdProofCopyDeps,
  type IdProofCopyJob,
} from '@/modules/integration/bitrix/id-proof-copy';
import {
  ALERT_CHECK_MARGIN_MS,
  WORKER_INVOCATION_BUDGET_MS,
  handleWorkerRequest,
  type FileMoveResult,
  type WorkerEndpointDeps,
} from '@/modules/integration/bitrix/worker-endpoint';
import { asRpcClient, type RpcClient } from '@/modules/integration/commands';
import type { IntakeConfig } from '@/modules/integration/intake-config';
import {
  FileMoveCommandError,
  claimFileMoves,
  completeFileMove,
  confirmFileMoveRestored,
  fileMoveLeaseOk,
  recordFileMoveObservation,
  type FileMoveJob,
  type FileMoveRowJob,
  type FileMoveState,
  type FilePresenceJob,
  type ObservationResult,
} from '@/modules/integration/server/file-move-commands';
import {
  DELETE_MIN_LEASE_SECONDS,
  FILE_MOVE_STEP_WORST_CASE_MS,
  processFileMoveBatch,
  type FileMoveDeps,
  type RowLease,
} from '@/modules/integration/server/file-move-runtime';
import { removeMovedSourceObject } from '@/modules/integration/server/file-storage-remove';

/**
 * S11 "files to Bitrix": the file-move worker core (file-move-runtime.ts),
 * end to end against a MOCK portal (stubbed fetch on synthetic loopback
 * webhooks) and an in-memory database that applies the freeze's rules
 * (claim modes, D6 copy-back, one writer per deal both ways, the in-flight
 * rule and the "lease after the last append" rule by the database clock,
 * database-side comparison, the lease check before a remove, the restore
 * read-back compared by the database).
 * The real DEC-43 batch (id-proof-copy.ts) runs against the same fakes for
 * the race cases. No real portal, no real credential, no Bitrix call.
 */

const PORTAL = 'synthetic.bitrix24.example';
const READ_BASE = 'http://127.0.0.1:1/rest/1/syntheticRead0001/';
const WRITE_BASE = 'http://127.0.0.1:1/rest/7/syntheticWrite001/';
const ACCOUNTS_BOX = 'ufCrm_AccountsPapers';
const HOLD_MS = 15 * 60_000;
const DEAL = '501';
const target = (base: string) => resolveBitrixRestTarget(base, PORTAL, 'local');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const bytesOf = (label: string) => new TextEncoder().encode(`synthetic pretend file ${label} `.repeat(3));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// Mock portal: Deals with two file boxes, crm.item.get, crm.item.update, urlMachine downloads
// ---------------------------------------------------------------------------

type ReadFailure = 'rate' | 'down' | null;

class MockPortal {
  readonly boxes = new Map<string, number[]>();
  readonly deals = new Set<string>();
  readonly files = new Map<number, Uint8Array>();
  readonly log: string[] = [];
  readonly writes: Array<{ box: string; kept: number[]; names: string[] }> = [];
  nextId = 900;
  /** The next crm.item.update waits for `release` (write held open); `started` resolves when it arrives. */
  gate: { started: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | null = null;
  /** Ids Bitrix drops on the next append that is applied (the documented risk of a multiple file field). */
  dropOnAppend: number[] = [];
  /** 'later': the next update's answer is lost and the request lands only on landLate(); 'now': applied, answer lost. */
  loseAnswer: 'later' | 'now' | null = null;
  private late: Record<string, unknown> | null = null;
  /** One entry per crm.item.get, consumed in order. */
  readFailures: ReadFailure[] = [];
  writeFailure: 'rate' | '5xx' | 'auth' | null = null;
  failDownloads = false;
  /** Downloads of these ids return other bytes. */
  readonly corrupt = new Set<number>();
  /** Runs inside the next crm.item.get (another worker acting meanwhile). */
  onRead: (() => void) | null = null;

  addDeal(deal: string) {
    this.deals.add(deal);
    for (const box of [IDENTITY_BOX, ACCOUNTS_BOX]) if (!this.boxes.has(`${deal}|${box}`)) this.boxes.set(`${deal}|${box}`, []);
  }
  put(deal: string, box: string, bytes: Uint8Array): number {
    this.addDeal(deal);
    const id = (this.nextId += 1);
    this.files.set(id, bytes);
    this.boxes.get(`${deal}|${box}`)!.push(id);
    return id;
  }
  ids(deal: string, box: string): number[] {
    return [...(this.boxes.get(`${deal}|${box}`) ?? [])];
  }
  landLate() {
    if (this.late) this.apply(this.late);
    this.late = null;
  }
  private entries(deal: string, box: string) {
    return this.ids(deal, box).map((id) => ({ id, url: '/bitrix/services/main/ajax.php', urlMachine: `${READ_BASE}crm.controller.item.getFile/?token=syntheticFileToken${id}&fileId=${id}` }));
  }
  private apply(body: Record<string, unknown>) {
    const deal = String(body.id);
    const fields = body.fields as Record<string, Array<{ id: number } | [string, string]>>;
    const box = Object.keys(fields)[0]!;
    const value = fields[box]!;
    const kept = value.filter((v): v is { id: number } => !Array.isArray(v)).map((v) => v.id);
    const added: number[] = [];
    for (const v of value.filter((x): x is [string, string] => Array.isArray(x))) {
      const id = (this.nextId += 1);
      this.files.set(id, new Uint8Array(Buffer.from(v[1], 'base64')));
      added.push(id);
    }
    const drop = new Set(this.dropOnAppend);
    this.dropOnAppend = [];
    this.boxes.set(`${deal}|${box}`, [...this.ids(deal, box).filter((id) => kept.includes(id)), ...added].filter((id) => !drop.has(id)));
    this.writes.push({ box, kept, names: value.filter((x): x is [string, string] => Array.isArray(x)).map((x) => x[0]) });
  }

  readonly fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (u === `${READ_BASE}crm.item.get.json`) {
      this.log.push('read');
      const hook = this.onRead;
      this.onRead = null;
      hook?.();
      const failure = this.readFailures.shift() ?? null;
      if (failure === 'rate') return json({ error: 'QUERY_LIMIT_EXCEEDED' }, 503);
      if (failure === 'down') return new Response('bad gateway', { status: 502 });
      const body = JSON.parse(String(init?.body)) as { id: number };
      const deal = String(body.id);
      if (!this.deals.has(deal)) return json({ error: 'NOT_FOUND', error_description: 'Element not found' }, 400);
      return json({ result: { item: { id: body.id, title: 'Synthetic', [IDENTITY_BOX]: this.entries(deal, IDENTITY_BOX), [ACCOUNTS_BOX]: this.entries(deal, ACCOUNTS_BOX) } } });
    }
    const file = /crm\.controller\.item\.getFile\/\?token=syntheticFileToken\d+&fileId=(\d+)$/.exec(u);
    if (file && u.startsWith(READ_BASE)) {
      const id = Number(file[1]);
      this.log.push(`download ${id}`);
      const bytes = this.files.get(id);
      if (this.failDownloads || !bytes) return json({ error: 'NOT_FOUND' }, 404);
      const served = this.corrupt.has(id) ? new TextEncoder().encode('re-encoded by the portal') : bytes;
      return new Response(Buffer.from(served), { headers: { 'content-type': 'application/octet-stream' } });
    }
    if (u === `${WRITE_BASE}crm.item.update.json`) {
      this.log.push('write');
      const gate = this.gate;
      this.gate = null;
      if (gate) {
        gate.started.resolve();
        await gate.release.promise;
      }
      if (this.writeFailure === 'rate') return json({ error: 'QUERY_LIMIT_EXCEEDED' }, 503);
      if (this.writeFailure === '5xx') return new Response('bad gateway', { status: 502 });
      if (this.writeFailure === 'auth') return json({ error: 'ACCESS_DENIED' }, 403);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const lose = this.loseAnswer;
      this.loseAnswer = null;
      if (lose === 'later') {
        this.late = body;
        throw new TypeError('fetch failed');
      }
      this.apply(body);
      if (lose === 'now') throw new TypeError('fetch failed');
      const box = Object.keys(body.fields as Record<string, unknown>)[0]!;
      return json({ result: { item: { id: body.id, [box]: this.entries(String(body.id), box) } } });
    }
    this.log.push('other');
    return json({ error: 'ERROR_METHOD_NOT_FOUND' }, 404);
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// In-memory database applying the freeze's rules
// ---------------------------------------------------------------------------

interface Row {
  id: string;
  fileClass: 'id_proof' | 'accounts';
  kindCode: FileMoveRowJob['kindCode'];
  sourceTable: FileMoveRowJob['sourceTable'];
  deal: string;
  box: string;
  bucket: string;
  path: string;
  mime: FileMoveRowJob['mime'];
  size: number;
  sha: string;
  state: FileMoveState;
  crmCopy: boolean;
  bitrixFileId: number | null;
  prior: number[];
  deleteAfter: number | null;
  relocateDue: boolean;
  keepInCrm: boolean;
  lease: string | null;
  lockedUntil: number;
  /** Database time the current lease was handed out (leased_at). */
  leasedAt: number;
  leaseMode: FileMoveRowJob['mode'] | null;
  /** The lease in which the copy-back download matched (restore_checked_at of this lease). */
  restoreChecked: string | null;
  notBefore: number;
  attempts: number;
  lastCode: string | null;
}

interface Dec43Job {
  jobId: string;
  deal: string;
  path: string;
  mime: string;
  size: number;
  sha: string;
  status: 'pending' | 'unknown' | 'sent' | 'failed';
  lease: string | null;
  lockedUntil: number;
  notBefore: number;
  prior: number[];
  bitrixFileId: number | null;
}

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String((seq += 1)).padStart(12, '0')}`;

class FakeDb {
  now = Date.parse('2026-12-01T10:00:00Z');
  readonly rows: Row[] = [];
  readonly dec43: Dec43Job[] = [];
  readonly lastAppend = new Map<string, number>();
  readonly storage = new Map<string, Uint8Array>();
  readonly switches = { check: true, accounts: true, del: true };
  readonly stops: string[] = [];
  /** Codes and answers only, in order (the leak test scans the same shape). */
  readonly trail: string[] = [];
  readonly removed: string[] = [];
  readonly uploads: Array<{ key: string; bytes: Uint8Array }> = [];
  presenceDue: { deal: string; box: string } | null = null;
  readonly presenceCalls: Array<number[] | null> = [];
  failConfirmDeletedOnce = false;

  addRow(o: {
    name: string;
    bytes: Uint8Array;
    box?: string;
    deal?: string;
    state?: FileMoveState;
    crmCopy?: boolean;
    bitrixFileId?: number | null;
    deleteAfter?: number | null;
    relocateDue?: boolean;
    fileClass?: Row['fileClass'];
  }): Row {
    const box = o.box ?? IDENTITY_BOX;
    const fileClass = o.fileClass ?? (box === IDENTITY_BOX ? 'id_proof' : 'accounts');
    const row: Row = {
      id: uuid(),
      fileClass,
      kindCode: fileClass === 'id_proof' ? 'id' : 'bank',
      sourceTable: fileClass === 'id_proof' ? 'department_evidence' : 'finance_evidence',
      deal: o.deal ?? DEAL,
      box,
      bucket: fileClass === 'id_proof' ? 'department-evidence' : 'finance-evidence',
      path: `e/${o.name}`,
      mime: 'application/pdf',
      size: o.bytes.byteLength,
      sha: sha(o.bytes),
      state: o.state ?? 'copy_pending',
      crmCopy: o.crmCopy ?? true,
      bitrixFileId: o.bitrixFileId ?? null,
      prior: [],
      deleteAfter: o.deleteAfter ?? (o.state === 'verified' ? this.now - 60_000 : null),
      relocateDue: o.relocateDue ?? false,
      keepInCrm: false,
      lease: null,
      lockedUntil: 0,
      leasedAt: 0,
      leaseMode: null,
      restoreChecked: null,
      notBefore: 0,
      attempts: 0,
      lastCode: null,
    };
    if (row.crmCopy) this.storage.set(`${row.bucket}/${row.path}`, o.bytes);
    this.rows.push(row);
    return row;
  }

  addDec43(o: { name: string; bytes: Uint8Array; deal?: string }): Dec43Job {
    const job: Dec43Job = {
      jobId: uuid(),
      deal: o.deal ?? DEAL,
      path: `t/${o.name}`,
      mime: 'image/jpeg',
      size: o.bytes.byteLength,
      sha: sha(o.bytes),
      status: 'pending',
      lease: null,
      lockedUntil: 0,
      notBefore: 0,
      prior: [],
      bitrixFileId: null,
    };
    this.storage.set(`traveller-id-proofs/${job.path}`, o.bytes);
    this.dec43.push(job);
    return job;
  }

  private key = (deal: string, box: string) => `${deal}|${box}`;
  private leased = (l: { lease: string | null; lockedUntil: number }) => l.lease !== null && l.lockedUntil > this.now;

  /** An append is in flight for the deal and box (S11 sending/unknown; DEC-43 leased or unknown). */
  inFlight(deal: string, box: string, o: { exceptRow?: string; exceptJob?: string; s11Only?: boolean } = {}): boolean {
    const s11 = this.rows.some((r) => r.deal === deal && r.box === box && r.id !== o.exceptRow && (r.state === 'copy_sending' || r.state === 'copy_unknown'));
    if (s11 || o.s11Only || box !== IDENTITY_BOX) return s11;
    return this.dec43.some((j) => j.deal === deal && j.jobId !== o.exceptJob && (this.leased(j) || j.status === 'unknown'));
  }

  soleCopies(deal: string, box: string): Row[] {
    return this.rows.filter((r) => r.deal === deal && r.box === box && (!r.crmCopy || r.state === 'delete_pending') && r.state !== 'lost_accepted');
  }

  private expire() {
    for (const r of this.rows) {
      if (r.lease && r.lockedUntil <= this.now) {
        r.lease = null;
        if (r.state === 'copy_sending') r.state = 'copy_unknown';
      }
    }
    for (const j of this.dec43) if (j.lease && j.lockedUntil <= this.now) j.lease = null;
  }

  private takeLease(l: { lease: string | null; lockedUntil: number }) {
    l.lease = uuid();
    l.lockedUntil = this.now + 180_000;
  }

  private release(r: Row) {
    r.lease = null;
    r.lockedUntil = 0;
    r.leaseMode = null;
    // The lease ends, and with it any copy-back check made in it.
    r.restoreChecked = null;
  }

  private switchOn(r: Row) {
    return r.fileClass === 'id_proof' ? this.switches.check : this.switches.accounts;
  }

  private jobOf(r: Row, mode: FileMoveRowJob['mode']): FileMoveRowJob {
    const known = [
      ...this.rows.filter((x) => x.deal === r.deal && x.box === r.box && x.id !== r.id && x.bitrixFileId !== null).map((x) => x.bitrixFileId!),
      ...(r.box === IDENTITY_BOX ? this.dec43.filter((j) => j.deal === r.deal && j.bitrixFileId !== null).map((j) => j.bitrixFileId!) : []),
    ];
    return {
      moveId: r.id,
      leaseToken: r.lease!,
      mode,
      fileClass: r.fileClass,
      sourceTable: r.sourceTable,
      kindCode: r.kindCode,
      bitrixDealId: r.deal,
      bitrixField: r.box,
      bucket: r.bucket,
      objectPath: r.path,
      mime: r.mime,
      sizeBytes: r.size,
      sha256: r.sha,
      bitrixFileId: r.bitrixFileId,
      priorFileIds: r.prior,
      knownFileIds: known,
      attempts: r.attempts,
      // As Postgres writes leased_at into the job (microseconds, offset).
      leasedAt: new Date(r.leasedAt).toISOString().replace('Z', '456+00:00'),
    };
  }

  claim(): FileMoveJob | null {
    this.trail.push('claim');
    this.expire();
    for (let pass = 0; pass < 2; pass += 1) {
      let marked = false;
      const ordered = [...this.rows.filter((r) => r.state === 'restore_pending'), ...this.rows.filter((r) => r.state !== 'restore_pending')];
      for (const r of ordered) {
        if (r.lease || r.notBefore > this.now) continue;
        let mode: FileMoveRowJob['mode'] | null = null;
        if (r.relocateDue) mode = 'relocate';
        else if (r.state === 'restore_pending') mode = 'restore';
        else if (r.state === 'copy_pending') {
          if (!this.switchOn(r) || this.inFlight(r.deal, r.box)) continue;
          const sole = this.soleCopies(r.deal, r.box);
          if (sole.length > 0) {
            // D6: copy every sole copy back first; the append waits.
            for (const s of sole) {
              if (s.state !== 'restore_pending' && !s.lease) {
                s.state = 'restore_pending';
                marked = true;
              }
            }
            continue;
          }
          mode = 'copy';
        } else if (r.state === 'copy_unknown') mode = 'verify_copy';
        else if (r.state === 'copied' && this.switchOn(r)) mode = 'verify';
        else if (r.state === 'verified' && this.switches.del && r.deleteAfter !== null && r.deleteAfter <= this.now && !r.keepInCrm && !this.inFlight(r.deal, r.box)) mode = 'reverify';
        else if (r.state === 'delete_pending' && !this.inFlight(r.deal, r.box)) mode = this.switches.del ? 'delete' : 'confirm_delete';
        if (!mode) continue;
        this.takeLease(r);
        r.leasedAt = this.now;
        r.leaseMode = mode;
        r.restoreChecked = null;
        this.trail.push(`claimed ${mode}`);
        return this.jobOf(r, mode);
      }
      if (!marked) break;
    }
    if (this.presenceDue) {
      const { deal, box } = this.presenceDue;
      this.presenceDue = null;
      const job: FilePresenceJob = {
        moveId: null,
        leaseToken: uuid(),
        mode: 'presence',
        bitrixDealId: deal,
        bitrixField: box,
        expectedFileIds: this.rows.filter((r) => r.deal === deal && r.box === box && !r.crmCopy).map((r) => r.bitrixFileId!),
      };
      this.trail.push('claimed presence');
      return job;
    }
    return null;
  }

  private row(fn: string, job: RowLease): Row {
    const r = this.rows.find((x) => x.id === job.moveId);
    if (!r || r.lease !== job.leaseToken || r.lockedUntil <= this.now) throw new FileMoveCommandError(fn, 'PT409', 'task_conflict');
    return r;
  }

  markSending(job: RowLease, prior: number[]) {
    const r = this.row('file_move_mark_sending', job);
    // Under the per-deal lock: refuse while the box holds a sole copy or another append is in flight.
    if (this.soleCopies(r.deal, r.box).length > 0 || this.inFlight(r.deal, r.box, { exceptRow: r.id })) {
      throw new FileMoveCommandError('file_move_mark_sending', '55000', 'wrong_state');
    }
    r.state = 'copy_sending';
    r.prior = prior;
    r.attempts += 1;
    this.lastAppend.set(this.key(r.deal, r.box), this.now);
    this.trail.push('mark_sending');
  }

  recordObservation(job: RowLease, o: { bitrixFileId: number; sha256: string; sizeBytes: number; readStartedAt: string }): ObservationResult {
    // The observation reaches the database a little after the read began (time passes in a real call).
    this.now += 5;
    const r = this.row('file_move_record_observation', job);
    const result = ((): ObservationResult => {
      // The database compares; the worker only reported what it observed.
      if (o.bitrixFileId !== r.bitrixFileId || o.sha256 !== r.sha || o.sizeBytes !== r.size) {
        if (r.state === 'restore_pending') {
          // A copy-back that differs is tried again (lost_in_bitrix only the fifth time).
          r.notBefore = this.now + 60_000;
          this.release(r);
          return 'retry';
        }
        r.state = 'quarantined';
        this.switches.del = false;
        this.stops.push('copy_mismatch');
        this.release(r);
        return 'quarantined';
      }
      if (r.state === 'restore_pending') {
        r.restoreChecked = r.lease;
        return 'restore_checked';
      }
      if (r.state === 'copied') {
        r.state = 'verified';
        r.deleteAfter = this.now + HOLD_MS;
        this.release(r);
        return 'verified';
      }
      if (r.state === 'verified') {
        // By the database clock: the lease began at or after the hold and after
        // the last append; the worker's read start lies between the lease and now.
        const started = Date.parse(o.readStartedAt);
        const last = this.lastAppend.get(this.key(r.deal, r.box)) ?? Number.NEGATIVE_INFINITY;
        const early = r.deleteAfter === null || this.now < r.deleteAfter || r.leasedAt < r.deleteAfter;
        if (early || this.inFlight(r.deal, r.box) || !(r.leasedAt > last) || !(started >= r.leasedAt) || started > this.now) {
          this.release(r);
          return 'retry';
        }
        r.state = 'delete_pending';
        this.release(r);
        return 'delete_pending';
      }
      this.release(r);
      return 'retry';
    })();
    this.trail.push(`observation ${result}`);
    return result;
  }

  complete(job: RowLease, outcome: string, code: string | null, fileId: number | null) {
    const r = this.row('file_move_complete', job);
    r.lastCode = code;
    if (outcome === 'copied') {
      r.state = 'copied';
      r.bitrixFileId = fileId;
      this.lastAppend.set(this.key(r.deal, r.box), this.now);
    } else if (outcome === 'unknown') {
      r.state = 'copy_unknown';
      r.notBefore = this.now + 60_000;
    } else if (outcome === 'not_sent') {
      r.state = 'copy_pending';
      r.notBefore = this.now + 60_000;
    } else if (outcome === 'retry') {
      // After a marked send a retry is read back first, as unknown is.
      if (r.state === 'copy_sending' || r.state === 'copy_unknown') r.state = 'copy_unknown';
      r.attempts += 1;
      r.notBefore = this.now + 60_000;
    } else if (outcome === 'failed') r.state = 'failed';
    else if (outcome === 'deal_not_found') {
      r.state = 'failed';
      this.stops.push('deal_not_found');
    } else if (outcome === 'not_in_box') r.relocateDue = true;
    this.release(r);
    this.trail.push(`complete ${outcome}${code ? ` ${code}` : ''}`);
  }

  confirmDeleted(job: RowLease): 'deleted' | 'still_present' | 'back_to_verified' {
    if (this.failConfirmDeletedOnce) {
      this.failConfirmDeletedOnce = false;
      throw new Error('connection reset');
    }
    const r = this.row('file_move_confirm_deleted', job);
    this.release(r);
    let result: 'deleted' | 'still_present' | 'back_to_verified';
    if (!this.storage.has(`${r.bucket}/${r.path}`)) {
      r.state = 'deleted';
      r.crmCopy = false;
      result = 'deleted';
    } else if (this.switches.del) result = 'still_present';
    else {
      r.state = 'verified';
      result = 'back_to_verified';
    }
    this.trail.push(`confirm_deleted ${result}`);
    return result;
  }

  readonly restoredWith: Array<{ sha256: string; sizeBytes: number }> = [];

  confirmRestored(job: RowLease, stored: { sha256: string; sizeBytes: number }): 'restored' | 'missing' {
    const r = this.row('file_move_confirm_restored', job);
    // A copy-back check made in THIS lease is needed.
    if (r.restoreChecked !== job.leaseToken) throw new FileMoveCommandError('file_move_confirm_restored', '55000', 'wrong_state');
    this.restoredWith.push(stored);
    this.release(r);
    const obj = this.storage.get(`${r.bucket}/${r.path}`);
    // The database compares the read-back with the row, and looks at Storage itself.
    const same = stored.sha256 === r.sha && stored.sizeBytes === r.size;
    const result = same && obj && obj.byteLength === r.size ? 'restored' : 'missing';
    if (result === 'restored') {
      r.crmCopy = true;
      // Copied back: it goes through check, hold, second check and deletion again.
      r.state = 'copied';
    } else {
      r.lastCode = same ? 'restore_missing' : 'restore_mismatch';
      r.notBefore = this.now + 60_000;
    }
    this.trail.push(`confirm_restored ${result}`);
    return result;
  }

  /** file_move_lease_ok: this delete lease, delete_pending, enough lease left, deletion still allowed. */
  leaseOk(job: RowLease, minSeconds: number): boolean {
    const r = this.rows.find((x) => x.id === job.moveId);
    const ok = !!r && r.lease === job.leaseToken && r.leaseMode === 'delete' && r.state === 'delete_pending'
      && r.lockedUntil >= this.now + minSeconds * 1000 && this.switches.del && this.switchOn(r) && !r.keepInCrm;
    this.trail.push(`lease_ok ${ok}`);
    return ok;
  }

  stop(job: RowLease, reason: string) {
    const r = this.row('file_move_stop', job);
    r.state = 'failed';
    this.switches.del = false;
    this.stops.push(reason);
    this.release(r);
    this.trail.push(`stop ${reason}`);
  }

  relocated(job: RowLease, o: { newFileId: number; sha256: string; sizeBytes: number }): 'relocated' | 'no_match' {
    const r = this.row('file_move_relocated', job);
    if (o.sha256 === r.sha && o.sizeBytes === r.size) {
      r.bitrixFileId = o.newFileId;
      r.relocateDue = false;
      this.release(r);
      this.trail.push('relocated');
      return 'relocated';
    }
    this.trail.push('relocate no_match');
    return 'no_match';
  }

  // DEC-43 (restated claim, mark-sending and complete).
  dec43Claim(): IdProofCopyJob[] {
    this.expire();
    for (const j of this.dec43) {
      if (j.lease || j.notBefore > this.now || (j.status !== 'pending' && j.status !== 'unknown')) continue;
      if (this.inFlight(j.deal, IDENTITY_BOX, { s11Only: true })) continue;
      if (this.dec43.some((o) => o.jobId !== j.jobId && o.deal === j.deal && (this.leased(o) || o.status === 'unknown'))) continue;
      const sole = this.soleCopies(j.deal, IDENTITY_BOX);
      if (sole.length > 0) {
        for (const s of sole) if (s.state !== 'restore_pending' && !s.lease) s.state = 'restore_pending';
        continue;
      }
      this.takeLease(j);
      return [
        {
          jobId: j.jobId,
          leaseToken: j.lease!,
          mode: j.status === 'unknown' ? 'verify' : 'send',
          bitrixDealId: j.deal,
          objectPath: j.path,
          mime: j.mime,
          sizeBytes: j.size,
          sha256: j.sha,
          travellerSeq: 1,
          priorFileIds: j.prior,
          attempts: 0,
        },
      ];
    }
    return [];
  }
  private dec43Job(job: IdProofCopyJob): Dec43Job {
    const j = this.dec43.find((x) => x.jobId === job.jobId);
    if (!j || j.lease !== job.leaseToken) throw new Error('task_conflict');
    return j;
  }
  dec43MarkSending(job: IdProofCopyJob, prior: number[]) {
    const j = this.dec43Job(job);
    j.status = 'unknown';
    j.prior = prior;
    this.lastAppend.set(this.key(j.deal, IDENTITY_BOX), this.now);
  }
  dec43Complete(job: IdProofCopyJob, outcome: string, _code: string | null, fileId: number | null) {
    const j = this.dec43Job(job);
    j.lease = null;
    if (outcome === 'sent') {
      j.status = 'sent';
      j.bitrixFileId = fileId;
      this.lastAppend.set(this.key(j.deal, IDENTITY_BOX), this.now);
    } else if (outcome === 'retry') {
      j.status = 'pending';
      j.notBefore = this.now + 60_000;
    } else if (outcome === 'unknown') j.status = 'unknown';
    else j.status = 'failed';
  }
  dec43Stop(job: IdProofCopyJob, reason: string) {
    const j = this.dec43Job(job);
    j.lease = null;
    j.status = 'failed';
    this.stops.push(`dec43 ${reason}`);
  }
}

// ---------------------------------------------------------------------------
// Wiring the fakes into the real core and the real DEC-43 batch
// ---------------------------------------------------------------------------

function deps(db: FakeDb, portal: MockPortal, over: Partial<FileMoveDeps> & { noWriter?: boolean } = {}): FileMoveDeps {
  const { noWriter, ...rest } = over;
  const storageClient = {
    storage: {
      from: (bucket: string) => ({
        remove: async (paths: string[]) => {
          for (const p of paths) {
            db.removed.push(`${bucket}/${p}`);
            db.storage.delete(`${bucket}/${p}`);
          }
          return { data: [], error: null };
        },
      }),
    },
  };
  return {
    now: () => db.now,
    deadline: db.now + 10 * 60_000,
    claim: async () => db.claim(),
    markSending: async (job, prior) => db.markSending(job, prior),
    recordObservation: async (job, o) => db.recordObservation(job, o),
    complete: async (job, outcome, code, fileId) => db.complete(job, outcome, code, fileId),
    confirmDeleted: async (job) => db.confirmDeleted(job),
    confirmRestored: async (job, stored) => db.confirmRestored(job, stored),
    leaseOk: async (job, minSeconds) => db.leaseOk(job, minSeconds),
    stop: async (job, reason) => db.stop(job, reason),
    presence: async (_job, ids) => {
      db.presenceCalls.push(ids);
      db.trail.push('presence');
    },
    relocated: async (job, o) => db.relocated(job, o),
    reader: createBitrixFileReader({ target: target(READ_BASE), fetchImpl: portal.fetchImpl }),
    writerFor: (accountsBox) => (noWriter ? null : createBitrixFileWriter({ target: target(WRITE_BASE), accountsBox, fetchImpl: portal.fetchImpl })),
    downloadCrm: async (bucket, path) => {
      const b = db.storage.get(`${bucket}/${path}`);
      if (!b) throw new Error('missing');
      return b;
    },
    uploadCrm: async (bucket, path, bytes) => {
      db.trail.push('upload');
      const key = `${bucket}/${path}`;
      if (db.storage.has(key)) return 'exists';
      db.uploads.push({ key, bytes });
      db.storage.set(key, bytes);
      return 'uploaded';
    },
    removeCrm: (bucket, path) => removeMovedSourceObject(storageClient, bucket, path),
    ...rest,
  };
}

function dec43Deps(db: FakeDb, portal: MockPortal): IdProofCopyDeps {
  const client = createBitrixClient({ target: target(READ_BASE), fetchImpl: portal.fetchImpl, sleep: async () => undefined, maxRateLimitRetries: 0 });
  return {
    claim: async () => db.dec43Claim(),
    markSending: async (job, prior) => db.dec43MarkSending(job, prior),
    complete: async (job, outcome, code, fileId) => db.dec43Complete(job, outcome, code, fileId),
    stop: async (job, reason) => db.dec43Stop(job, reason),
    inspectFile: createFieldFileInspector({ target: target(READ_BASE), fetchImpl: portal.fetchImpl, sha256: sha }),
    readDealItem: async (id) => {
      const r = await client.getDealItemField(id, ID_PROOF_ITEM_FIELD);
      return r.kind === 'ok' ? { [ID_PROOF_ITEM_FIELD]: r.value } : null;
    },
    download: async (path) => {
      const b = db.storage.get(`traveller-id-proofs/${path}`);
      if (!b) throw new Error('missing');
      return b;
    },
    sha256: sha,
    writer: createBitrixIdProofWriter({ target: target(WRITE_BASE), fetchImpl: portal.fetchImpl }),
  };
}

function setup() {
  const portal = new MockPortal();
  portal.addDeal(DEAL);
  return { portal, db: new FakeDb() };
}

const writes = (portal: MockPortal) => portal.log.filter((l) => l === 'write').length;

// ---------------------------------------------------------------------------

describe('full path: copy, first check, hold, second check, delete', () => {
  for (const box of [IDENTITY_BOX, ACCOUNTS_BOX]) {
    it(`${box === IDENTITY_BOX ? 'identity' : 'Accounts'} box: append-only copy, database-compared checks, Storage delete after the hold`, async () => {
      const { portal, db } = setup();
      const earlier = portal.put(DEAL, box, bytesOf('earlier'));
      const otherBox = portal.put(DEAL, box === IDENTITY_BOX ? ACCOUNTS_BOX : IDENTITY_BOX, bytesOf('other box'));
      const bytes = bytesOf('new paper');
      const y = db.addRow({ name: 'new', bytes, box });

      const first = await processFileMoveBatch(deps(db, portal));
      expect(first).toMatchObject({ claimed: 2, done: { copied: 1, verified: 1 }, stopped: false, endedBy: 'no_work' });
      expect(y.state).toBe('verified');
      expect(portal.writes).toHaveLength(1);
      const w = portal.writes[0]!;
      expect(w.box).toBe(box);
      expect(w.kept).toEqual([earlier]);
      expect(w.names).toEqual([box === IDENTITY_BOX ? `id-${y.sha.slice(0, 8)}.pdf` : `acc-bank-${y.sha.slice(0, 8)}.pdf`]);
      // The other box was never part of any request and is unchanged.
      expect(portal.ids(DEAL, box === IDENTITY_BOX ? ACCOUNTS_BOX : IDENTITY_BOX)).toEqual([otherBox]);

      // Before the hold: nothing more is handed out, nothing deleted.
      expect((await processFileMoveBatch(deps(db, portal))).claimed).toBe(0);
      expect(db.removed).toEqual([]);

      db.now += HOLD_MS;
      const second = await processFileMoveBatch(deps(db, portal));
      expect(second).toMatchObject({ done: { delete_pending: 1, delete_deleted: 1 }, stopped: false });
      expect(y.state).toBe('deleted');
      expect(y.crmCopy).toBe(false);
      expect(db.removed).toEqual([`${y.bucket}/${y.path}`]);
      // Bitrix now holds the only copy, byte for byte; only one write was ever made.
      expect(sha(portal.files.get(y.bitrixFileId!)!)).toBe(y.sha);
      expect(writes(portal)).toBe(1);
      expect(db.trail.indexOf('observation verified')).toBeLessThan(db.trail.indexOf('observation delete_pending'));
    });
  }
});

describe('D6: a box is never rewritten while it holds a sole copy', () => {
  for (const box of [IDENTITY_BOX, ACCOUNTS_BOX]) {
    it(`${box === IDENTITY_BOX ? 'identity' : 'Accounts'} box: the sole copy is copied back first; the mock then drops it on the append and the CRM still holds it`, async () => {
      const { portal, db } = setup();
      const xBytes = bytesOf('sole copy');
      const xId = portal.put(DEAL, box, xBytes);
      const x = db.addRow({ name: 'x', bytes: xBytes, box, state: 'deleted', crmCopy: false, bitrixFileId: xId });
      const y = db.addRow({ name: 'y', bytes: bytesOf('later upload'), box });
      // The hold of X passed long ago.
      db.now += 7 * 24 * 60 * 60_000;
      portal.dropOnAppend = [xId];

      const run = await processFileMoveBatch(deps(db, portal));
      expect(run.stopped).toBe(true);
      expect(run.errors).toContain('prior_files_lost');
      // X came back to the CRM before Y's append, and only after the database said equal.
      expect(db.trail.indexOf('observation restore_checked')).toBeGreaterThan(-1);
      expect(db.trail.indexOf('observation restore_checked')).toBeLessThan(db.trail.indexOf('upload'));
      expect(db.trail.indexOf('confirm_restored restored')).toBeLessThan(db.trail.indexOf('mark_sending'));
      expect(db.storage.get(`${x.bucket}/${x.path}`)).toEqual(xBytes);
      expect(x.crmCopy).toBe(true);
      // Bitrix lost X on Y's append, but X is not lost; Y stopped; the delete switch is off.
      expect(portal.ids(DEAL, box)).not.toContain(xId);
      expect(y.state).toBe('failed');
      expect(db.stops).toContain('prior_files_lost');
      expect(db.switches.del).toBe(false);
      expect(db.removed).toEqual([]);
    });
  }

  it('mark_sending refused under the lock (a sole copy appeared after the claim): nothing is written, the job is handed back', async () => {
    const { portal, db } = setup();
    db.addRow({ name: 'y', bytes: bytesOf('y') });
    const run = await processFileMoveBatch(
      deps(db, portal, {
        markSending: async () => {
          throw new FileMoveCommandError('file_move_mark_sending', '55000', 'wrong_state');
        },
        maxJobs: 1,
      }),
    );
    expect(run.done).toEqual({ send_refused: 1 });
    expect(writes(portal)).toBe(0);
    expect(db.trail).toContain('complete released');
  });
});

describe('B1 interleaved: no second check or deletion while an append is in flight', () => {
  function verifiedX(portal: MockPortal) {
    const xBytes = bytesOf('older file x');
    const xId = portal.put(DEAL, IDENTITY_BOX, xBytes);
    return { xId, xBytes };
  }

  it('S11 append held open: a second worker gets no second check of X; the mock drops X; X is still in the CRM and Y stops', async () => {
    const { portal, db } = setup();
    const y = db.addRow({ name: 'y', bytes: bytesOf('y') });
    const { xId, xBytes } = verifiedX(portal);
    const x = db.addRow({ name: 'x', bytes: xBytes, state: 'verified', bitrixFileId: xId });
    const gate = { started: deferred(), release: deferred() };
    portal.gate = gate;
    const workerA = processFileMoveBatch(deps(db, portal));
    await gate.started.promise;
    expect(y.state).toBe('copy_sending');

    const workerB = await processFileMoveBatch(deps(db, portal));
    expect(workerB.claimed).toBe(0);

    portal.dropOnAppend = [xId];
    gate.release.resolve();
    const a = await workerA;
    expect(a).toMatchObject({ stopped: true, endedBy: 'stopped' });
    expect(a.errors).toContain('prior_files_lost');
    expect(x.state).toBe('verified');
    expect(db.storage.get(`${x.bucket}/${x.path}`)).toEqual(xBytes);
    expect(db.removed).toEqual([]);
  });

  it('the same with Y as a DEC-43 job held open', async () => {
    const { portal, db } = setup();
    const { xId, xBytes } = verifiedX(portal);
    const x = db.addRow({ name: 'x', bytes: xBytes, state: 'verified', bitrixFileId: xId });
    db.addDec43({ name: 'traveller proof', bytes: bytesOf('traveller proof') });
    // The gate object is captured before the call: the portal clears its own reference when the write arrives.
    const gate = { started: deferred(), release: deferred() };
    portal.gate = gate;
    const dec43 = processIdProofCopyBatch(dec43Deps(db, portal), 1);
    await gate.started.promise;

    const workerB = await processFileMoveBatch(deps(db, portal));
    expect(workerB.claimed).toBe(0);

    portal.dropOnAppend = [xId];
    gate.release.resolve();
    const d = await dec43;
    expect(d.stopped).toBe(true);
    expect(x.state).toBe('verified');
    expect(db.storage.get(`${x.bucket}/${x.path}`)).toEqual(xBytes);
    expect(db.removed).toEqual([]);
  });

  it('the same with Y in copy_unknown whose lost request lands late; Y is never sent twice', async () => {
    const { portal, db } = setup();
    const y = db.addRow({ name: 'y', bytes: bytesOf('y') });
    const { xId, xBytes } = verifiedX(portal);
    const x = db.addRow({ name: 'x', bytes: xBytes, state: 'verified', bitrixFileId: xId });
    portal.loseAnswer = 'later';

    const a = await processFileMoveBatch(deps(db, portal));
    expect(a.done).toMatchObject({ unknown: 1 });
    expect(y.state).toBe('copy_unknown');
    expect(y.lastCode).toBe('answer_network');
    // Y is undecided: X gets no second check, from this worker or another.
    expect(a.done).not.toHaveProperty('delete_pending');
    expect((await processFileMoveBatch(deps(db, portal))).claimed).toBe(0);

    portal.dropOnAppend = [xId];
    portal.landLate();
    db.now += 61_000;
    const c = await processFileMoveBatch(deps(db, portal));
    expect(c.errors).toContain('prior_files_lost');
    expect(x.state).toBe('verified');
    expect(db.storage.get(`${x.bucket}/${x.path}`)).toEqual(xBytes);
    expect(db.removed).toEqual([]);
    expect(writes(portal)).toBe(1);
  });

  it('a second check whose lease started before the last append does not count (database clock)', async () => {
    const { portal, db } = setup();
    const { xId, xBytes } = verifiedX(portal);
    const x = db.addRow({ name: 'x', bytes: xBytes, state: 'verified', bitrixFileId: xId });
    // Another worker's append to the same box settles while X's box is being read.
    portal.onRead = () => {
      db.now += 1_000;
      db.lastAppend.set(`${DEAL}|${IDENTITY_BOX}`, db.now);
    };
    const run = await processFileMoveBatch(deps(db, portal, { maxJobs: 1 }));
    expect(run.done).toEqual({ retry: 1 });
    expect(x.state).toBe('verified');
    expect(db.removed).toEqual([]);
    // A fresh check after that append counts.
    db.now += 1_000;
    const again = await processFileMoveBatch(deps(db, portal));
    expect(again.done).toMatchObject({ delete_pending: 1, delete_deleted: 1 });
  });
});

describe('the read start is derived from the database lease start, not the app clock', () => {
  for (const skewMs of [10 * 60_000, -10 * 60_000]) {
    it(`app clock ${skewMs > 0 ? 'far ahead' : 'far behind'}: readStartedAt = leasedAt + 1 ms (+ time since the claim); the second check counts`, async () => {
      const { portal, db } = setup();
      const bytes = bytesOf('x');
      const id = portal.put(DEAL, IDENTITY_BOX, bytes);
      const x = db.addRow({ name: 'x', bytes, state: 'verified', bitrixFileId: id });
      const leaseAt = db.now;
      const seen: string[] = [];
      const appNow = () => db.now + skewMs;
      const run = await processFileMoveBatch(deps(db, portal, {
        now: appNow,
        deadline: appNow() + 10 * 60_000,
        recordObservation: async (job, o) => {
          seen.push(o.readStartedAt);
          return db.recordObservation(job, o);
        },
        maxJobs: 1,
      }));
      expect(run.done).toEqual({ delete_pending: 1 });
      expect(seen).toEqual([new Date(leaseAt + 1).toISOString()]);
      expect(x.state).toBe('delete_pending');
    });
  }

  it('time spent after the claim is added (measured on the app clock), so the read start never falls before the lease', async () => {
    const { portal, db } = setup();
    const bytes = bytesOf('x');
    const id = portal.put(DEAL, IDENTITY_BOX, bytes);
    db.addRow({ name: 'x', bytes, state: 'verified', bitrixFileId: id });
    const leaseAt = db.now;
    let app = db.now + 3_600_000;
    const seen: string[] = [];
    const run = await processFileMoveBatch(deps(db, portal, {
      // Every app-clock reading moves 2 ms on (the database clock moves too).
      now: () => {
        app += 2;
        db.now += 2;
        return app;
      },
      deadline: app + 10 * 60_000,
      recordObservation: async (job, o) => {
        seen.push(o.readStartedAt);
        return db.recordObservation(job, o);
      },
      maxJobs: 1,
    }));
    expect(run.done).toEqual({ delete_pending: 1 });
    expect(seen).toHaveLength(1);
    const reported = Date.parse(seen[0]!);
    expect(reported).toBeGreaterThan(leaseAt);
    expect(reported).toBeLessThanOrEqual(db.now);
  });

  it('with the app clock ahead, a lease that began before the last append is still refused', async () => {
    const { portal, db } = setup();
    const bytes = bytesOf('x');
    const id = portal.put(DEAL, IDENTITY_BOX, bytes);
    const x = db.addRow({ name: 'x', bytes, state: 'verified', bitrixFileId: id });
    // An append to the box settles while X's box is read (after X's lease began).
    portal.onRead = () => {
      db.now += 1_000;
      db.lastAppend.set(`${DEAL}|${IDENTITY_BOX}`, db.now);
    };
    const appNow = () => db.now + 10 * 60_000;
    const run = await processFileMoveBatch(deps(db, portal, { now: appNow, deadline: appNow() + 10 * 60_000, maxJobs: 1 }));
    expect(run.done).toEqual({ retry: 1 });
    expect(x.state).toBe('verified');
    expect(db.removed).toEqual([]);
  });
});

describe('S11 and DEC-43 racing on one deal lose nothing', () => {
  it('S11 append in flight: DEC-43 gets no job; afterwards DEC-43 keeps the S11 file', async () => {
    const { portal, db } = setup();
    const original = portal.put(DEAL, IDENTITY_BOX, bytesOf('original'));
    const y = db.addRow({ name: 'visa paper', bytes: bytesOf('visa paper') });
    db.addDec43({ name: 'proof', bytes: bytesOf('traveller proof') });
    const gate = { started: deferred(), release: deferred() };
    portal.gate = gate;
    const s11 = processFileMoveBatch(deps(db, portal));
    await gate.started.promise;
    expect((await processIdProofCopyBatch(dec43Deps(db, portal), 1)).claimed).toBe(0);
    gate.release.resolve();
    await s11;
    expect(y.state).toBe('verified');
    const d = await processIdProofCopyBatch(dec43Deps(db, portal), 1);
    expect(d).toMatchObject({ claimed: 1, sent: 1, stopped: false });
    expect(portal.writes[1]!.kept).toEqual([original, y.bitrixFileId]);
    expect(portal.ids(DEAL, IDENTITY_BOX)).toEqual([original, y.bitrixFileId, db.dec43[0]!.bitrixFileId]);
    expect(db.stops).toEqual([]);
  });

  it('DEC-43 append in flight: S11 gets no copy for that deal; afterwards S11 keeps the DEC-43 file', async () => {
    const { portal, db } = setup();
    const original = portal.put(DEAL, IDENTITY_BOX, bytesOf('original'));
    const y = db.addRow({ name: 'visa paper', bytes: bytesOf('visa paper') });
    db.addDec43({ name: 'proof', bytes: bytesOf('traveller proof') });
    const gate = { started: deferred(), release: deferred() };
    portal.gate = gate;
    const dec43 = processIdProofCopyBatch(dec43Deps(db, portal), 1);
    await gate.started.promise;
    expect((await processFileMoveBatch(deps(db, portal))).claimed).toBe(0);
    gate.release.resolve();
    expect(await dec43).toMatchObject({ sent: 1 });
    const t = db.dec43[0]!.bitrixFileId!;
    await processFileMoveBatch(deps(db, portal));
    expect(portal.writes[1]!.kept).toEqual([original, t]);
    expect(portal.ids(DEAL, IDENTITY_BOX)).toEqual([original, t, y.bitrixFileId]);
    expect(db.stops).toEqual([]);
  });
});

describe('mismatch at each check is quarantined, never deleted or restored', () => {
  it('first check', async () => {
    const { portal, db } = setup();
    const id = portal.put(DEAL, IDENTITY_BOX, bytesOf('what Bitrix holds'));
    const r = db.addRow({ name: 'r', bytes: bytesOf('what the CRM holds'), state: 'copied', bitrixFileId: id });
    const run = await processFileMoveBatch(deps(db, portal));
    expect(run).toMatchObject({ stopped: true, endedBy: 'stopped', done: { quarantined: 1 } });
    expect(r.state).toBe('quarantined');
    expect(db.switches.del).toBe(false);
    expect(db.storage.has(`${r.bucket}/${r.path}`)).toBe(true);
  });

  it('second check (Bitrix now serves other bytes)', async () => {
    const { portal, db } = setup();
    const bytes = bytesOf('paper');
    const id = portal.put(DEAL, IDENTITY_BOX, bytes);
    const r = db.addRow({ name: 'r', bytes, state: 'verified', bitrixFileId: id });
    portal.corrupt.add(id);
    const run = await processFileMoveBatch(deps(db, portal));
    expect(run.done).toEqual({ quarantined: 1 });
    expect(r.state).toBe('quarantined');
    expect(db.removed).toEqual([]);
  });

  it('restore: a different file is never uploaded (the database answers retry, lost_in_bitrix the fifth time)', async () => {
    const { portal, db } = setup();
    const bytes = bytesOf('paper');
    const id = portal.put(DEAL, IDENTITY_BOX, bytes);
    const r = db.addRow({ name: 'r', bytes, state: 'restore_pending', crmCopy: false, bitrixFileId: id });
    portal.corrupt.add(id);
    const run = await processFileMoveBatch(deps(db, portal));
    expect(run.done).toEqual({ retry: 1 });
    expect(r.state).toBe('restore_pending');
    expect(db.trail).not.toContain('upload');
    expect(db.storage.has(`${r.bucket}/${r.path}`)).toBe(false);
  });

  it('copy: a CRM file that changed is not sent', async () => {
    const { portal, db } = setup();
    const r = db.addRow({ name: 'r', bytes: bytesOf('paper') });
    db.storage.set(`${r.bucket}/${r.path}`, bytesOf('changed'));
    const run = await processFileMoveBatch(deps(db, portal, { maxJobs: 1 }));
    expect(run.done).toEqual({ failed: 1 });
    expect(r.lastCode).toBe('crm_file_changed');
    expect(portal.log).toEqual([]);
  });
});

describe('Bitrix down or rate limited at each step: nothing lost, back-off, read back first', () => {
  it('copy, box read rate limited: retry with back-off, no write, the batch yields', async () => {
    const { portal, db } = setup();
    const r = db.addRow({ name: 'r', bytes: bytesOf('paper') });
    portal.readFailures = ['rate'];
    const run = await processFileMoveBatch(deps(db, portal));
    expect(run).toMatchObject({ endedBy: 'rate_limited', done: { retry: 1 } });
    expect(r.lastCode).toBe('bitrix_rate_limited');
    expect(writes(portal)).toBe(0);
    expect(portal.log.filter((l) => l === 'read')).toHaveLength(1);
    // Backed off: not handed out again at once.
    expect((await processFileMoveBatch(deps(db, portal))).claimed).toBe(0);
    expect(r.crmCopy).toBe(true);
  });

  it('copy, write rate limited: retry, read back first, then sent again; write auth refused: failed', async () => {
    const { portal, db } = setup();
    const r = db.addRow({ name: 'r', bytes: bytesOf('paper') });
    portal.writeFailure = 'rate';
    expect(await processFileMoveBatch(deps(db, portal))).toMatchObject({ endedBy: 'rate_limited' });
    // A marked send is read back before any new send.
    expect(r.state).toBe('copy_unknown');
    db.now += 61_000;
    expect((await processFileMoveBatch(deps(db, portal))).done).toEqual({ not_sent: 1 });
    db.now += 61_000;
    portal.writeFailure = 'auth';
    expect(await processFileMoveBatch(deps(db, portal))).toMatchObject({ endedBy: 'bitrix_auth' });
    expect(r.state).toBe('failed');
    expect(r.lastCode).toBe('bitrix_auth_failed');
  });

  it('copy, write answer lost (5xx): unknown, then decided by read-back (not sent), then sent once', async () => {
    const { portal, db } = setup();
    const r = db.addRow({ name: 'r', bytes: bytesOf('paper') });
    portal.writeFailure = '5xx';
    const a = await processFileMoveBatch(deps(db, portal));
    expect(a.done).toEqual({ unknown: 1 });
    expect(r.lastCode).toBe('answer_http_server_error');
    portal.writeFailure = null;
    db.now += 61_000;
    const b = await processFileMoveBatch(deps(db, portal));
    expect(b.done).toEqual({ not_sent: 1 });
    db.now += 61_000;
    const c = await processFileMoveBatch(deps(db, portal));
    expect(c.done).toEqual({ copied: 1, verified: 1 });
    expect(portal.ids(DEAL, IDENTITY_BOX)).toHaveLength(1);
  });

  it('copy, the write landed but the answer was lost: the read-back finds our file (copied), no second write', async () => {
    const { portal, db } = setup();
    const r = db.addRow({ name: 'r', bytes: bytesOf('paper') });
    portal.loseAnswer = 'now';
    await processFileMoveBatch(deps(db, portal));
    expect(r.state).toBe('copy_unknown');
    db.now += 61_000;
    const b = await processFileMoveBatch(deps(db, portal, { maxJobs: 1 }));
    expect(b.done).toEqual({ copied: 1 });
    expect(writes(portal)).toBe(1);
  });

  it('copy, read-back down: unknown (never re-sent blindly)', async () => {
    const { portal, db } = setup();
    const r = db.addRow({ name: 'r', bytes: bytesOf('paper') });
    portal.readFailures = [null, 'down'];
    await processFileMoveBatch(deps(db, portal, { maxJobs: 1 }));
    expect(r.state).toBe('copy_unknown');
    expect(r.lastCode).toBe('read_back_failed');
  });

  it('first check, box read down or download failing: retry, nothing observed', async () => {
    const { portal, db } = setup();
    const bytes = bytesOf('paper');
    const id = portal.put(DEAL, IDENTITY_BOX, bytes);
    const r = db.addRow({ name: 'r', bytes, state: 'copied', bitrixFileId: id });
    portal.readFailures = ['down'];
    expect(await processFileMoveBatch(deps(db, portal))).toMatchObject({ endedBy: 'bitrix_unavailable' });
    expect(r.lastCode).toBe('bitrix_unavailable');
    db.now += 61_000;
    portal.failDownloads = true;
    await processFileMoveBatch(deps(db, portal, { maxJobs: 1 }));
    expect(r.lastCode).toBe('download_http_error');
    expect(r.state).toBe('copied');
    expect(db.trail.some((t) => t.startsWith('observation'))).toBe(false);
  });

  it('delete, Storage failing: retry, the row stays delete_pending', async () => {
    const { portal, db } = setup();
    const r = db.addRow({ name: 'r', bytes: bytesOf('paper'), state: 'delete_pending', bitrixFileId: 5 });
    await processFileMoveBatch(deps(db, portal, { removeCrm: async () => ({ kind: 'error', code: 'storage_error' }), maxJobs: 1 }));
    expect(r.state).toBe('delete_pending');
    expect(r.lastCode).toBe('remove_storage_error');
  });
});

describe('crash between delete_pending and the remove; remove of an absent object', () => {
  it('a row left in delete_pending is finished by the next run', async () => {
    const { portal, db } = setup();
    const r = db.addRow({ name: 'r', bytes: bytesOf('paper'), state: 'delete_pending', bitrixFileId: 5 });
    const run = await processFileMoveBatch(deps(db, portal));
    expect(run.done).toEqual({ delete_deleted: 1 });
    expect(r.state).toBe('deleted');
    expect(portal.log).toEqual([]);
  });

  it('crash after the remove, before the database saw it: the next run removes an absent object (harmless) and confirms', async () => {
    const { portal, db } = setup();
    const r = db.addRow({ name: 'r', bytes: bytesOf('paper'), state: 'delete_pending', bitrixFileId: 5 });
    db.failConfirmDeletedOnce = true;
    const a = await processFileMoveBatch(deps(db, portal));
    expect(a).toMatchObject({ endedBy: 'db_error', errors: ['job_not_completed'] });
    expect(r.state).toBe('delete_pending');
    db.now += 181_000;
    const b = await processFileMoveBatch(deps(db, portal));
    expect(b.done).toEqual({ delete_deleted: 1 });
    expect(db.removed).toEqual([`${r.bucket}/${r.path}`, `${r.bucket}/${r.path}`]);
    expect(r.state).toBe('deleted');
  });

  it('delete: the lease is checked right before the remove; when not held, the job is released and nothing is removed', async () => {
    const { portal, db } = setup();
    const r = db.addRow({ name: 'r', bytes: bytesOf('paper'), state: 'delete_pending', bitrixFileId: 5 });
    const asked: number[] = [];
    const removeCrm = vi.fn<FileMoveDeps['removeCrm']>(async () => ({ kind: 'removed' }));
    const run = await processFileMoveBatch(deps(db, portal, {
      leaseOk: async (_job, minSeconds) => {
        asked.push(minSeconds);
        return false;
      },
      removeCrm,
      maxJobs: 1,
    }));
    expect(run).toMatchObject({ claimed: 1, done: { delete_lease_not_held: 1 }, stopped: false });
    expect(asked).toEqual([DELETE_MIN_LEASE_SECONDS]);
    expect(DELETE_MIN_LEASE_SECONDS).toBe(60);
    expect(removeCrm).not.toHaveBeenCalled();
    expect(db.removed).toEqual([]);
    expect(db.storage.has(`${r.bucket}/${r.path}`)).toBe(true);
    expect(db.trail).toContain('complete released');
    expect(db.trail).not.toContain('confirm_deleted deleted');
    expect(r).toMatchObject({ state: 'delete_pending', crmCopy: true, lease: null });
    expect(portal.log).toEqual([]);
  });

  it('delete: the delete switch turned off after the claim, or a lease with under 60 s left: no remove', async () => {
    for (const change of ['switch_off', 'short_lease'] as const) {
      const { portal, db } = setup();
      const r = db.addRow({ name: 'r', bytes: bytesOf('paper'), state: 'delete_pending', bitrixFileId: 5 });
      const run = await processFileMoveBatch(deps(db, portal, {
        claim: async () => {
          const job = db.claim();
          if (change === 'switch_off') db.switches.del = false;
          else r.lockedUntil = db.now + 59_000;
          return job;
        },
        maxJobs: 1,
      }));
      expect(run.done, change).toEqual({ delete_lease_not_held: 1 });
      expect(db.trail, change).toContain('lease_ok false');
      expect(db.removed, change).toEqual([]);
      expect(db.storage.has(`${r.bucket}/${r.path}`), change).toBe(true);
      expect(r.state, change).toBe('delete_pending');
    }
  });

  it('delete switch off: confirm only, never a remove', async () => {
    const { portal, db } = setup();
    db.switches.del = false;
    const present = db.addRow({ name: 'present', bytes: bytesOf('a'), state: 'delete_pending', bitrixFileId: 5 });
    const gone = db.addRow({ name: 'gone', bytes: bytesOf('b'), state: 'delete_pending', bitrixFileId: 6 });
    db.storage.delete(`${gone.bucket}/${gone.path}`);
    const run = await processFileMoveBatch(deps(db, portal));
    expect(run.done).toEqual({ delete_back_to_verified: 1, delete_deleted: 1 });
    expect(present.state).toBe('verified');
    expect(gone.state).toBe('deleted');
    expect(db.removed).toEqual([]);
  });
});

describe('restore', () => {
  it('uploads the hashed bytes only after the database answered restore_checked; an object already there is confirmed', async () => {
    const { portal, db } = setup();
    const bytes = bytesOf('paper');
    const id = portal.put(DEAL, IDENTITY_BOX, bytes);
    const r = db.addRow({ name: 'r', bytes, state: 'restore_pending', crmCopy: false, bitrixFileId: id });
    const run = await processFileMoveBatch(deps(db, portal, { maxJobs: 1 }));
    expect(run.done).toEqual({ restore_restored: 1 });
    expect(db.uploads).toEqual([{ key: `${r.bucket}/${r.path}`, bytes }]);
    expect(db.trail.indexOf('observation restore_checked')).toBeLessThan(db.trail.indexOf('upload'));
    expect(r.crmCopy).toBe(true);

    const again = db.addRow({ name: 'again', bytes, state: 'restore_pending', crmCopy: false, bitrixFileId: id });
    db.storage.set(`${again.bucket}/${again.path}`, bytes);
    expect((await processFileMoveBatch(deps(db, portal, { maxJobs: 1 }))).done).toEqual({ restore_restored: 1 });
  });

  it('restore: after the upload the object is read back from Storage and its hash and size go to the database', async () => {
    const { portal, db } = setup();
    const bytes = bytesOf('paper');
    const id = portal.put(DEAL, IDENTITY_BOX, bytes);
    db.addRow({ name: 'r', bytes, state: 'restore_pending', crmCopy: false, bitrixFileId: id });
    const reads: string[] = [];
    const run = await processFileMoveBatch(deps(db, portal, {
      downloadCrm: async (bucket, path) => {
        reads.push(`${bucket}/${path}`);
        return db.storage.get(`${bucket}/${path}`)!;
      },
      maxJobs: 1,
    }));
    expect(run.done).toEqual({ restore_restored: 1 });
    expect(reads).toHaveLength(1);
    expect(db.restoredWith).toEqual([{ sha256: sha(bytes), sizeBytes: bytes.byteLength }]);
    expect(db.trail.indexOf('upload')).toBeLessThan(db.trail.indexOf('confirm_restored restored'));
  });

  it("restore: an object already there ('exists') that differs is hashed and reported; the database answers missing; nothing is overwritten", async () => {
    const { portal, db } = setup();
    const bytes = bytesOf('paper A');
    const other = bytesOf('paper B');
    expect(other.byteLength).toBe(bytes.byteLength);
    const id = portal.put(DEAL, IDENTITY_BOX, bytes);
    const r = db.addRow({ name: 'r', bytes, state: 'restore_pending', crmCopy: false, bitrixFileId: id });
    // Same size, other content at the old path.
    db.storage.set(`${r.bucket}/${r.path}`, other);
    const run = await processFileMoveBatch(deps(db, portal, { maxJobs: 1 }));
    expect(run.done).toEqual({ restore_missing: 1 });
    expect(db.restoredWith).toEqual([{ sha256: sha(other), sizeBytes: other.byteLength }]);
    expect(r).toMatchObject({ state: 'restore_pending', crmCopy: false, lastCode: 'restore_mismatch', lease: null });
    expect(db.uploads).toEqual([]);
    expect(db.storage.get(`${r.bucket}/${r.path}`)).toEqual(other);
    expect(db.trail.indexOf('upload')).toBeLessThan(db.trail.indexOf('confirm_restored missing'));
  });

  it('restore: a read-back that fails is a retry, never a confirmation', async () => {
    const { portal, db } = setup();
    const bytes = bytesOf('paper');
    const id = portal.put(DEAL, IDENTITY_BOX, bytes);
    const r = db.addRow({ name: 'r', bytes, state: 'restore_pending', crmCopy: false, bitrixFileId: id });
    const run = await processFileMoveBatch(deps(db, portal, {
      downloadCrm: async () => {
        throw new Error('storage down');
      },
      maxJobs: 1,
    }));
    expect(run.done).toEqual({ retry: 1 });
    expect(r).toMatchObject({ state: 'restore_pending', crmCopy: false, lastCode: 'storage_read_back_failed', restoreChecked: null });
    expect(db.restoredWith).toEqual([]);
  });

  it('no upload when the database does not answer restore_checked', async () => {
    const { portal, db } = setup();
    const bytes = bytesOf('paper');
    const id = portal.put(DEAL, IDENTITY_BOX, bytes);
    db.addRow({ name: 'r', bytes, state: 'restore_pending', crmCopy: false, bitrixFileId: id });
    for (const answer of ['retry', 'verified'] as const) {
      const run = await processFileMoveBatch(deps(db, portal, { recordObservation: async () => answer, maxJobs: 1 }));
      expect(run.done).toEqual({ [answer]: 1 });
      db.now += 181_000;
    }
    expect(db.trail).not.toContain('upload');
  });

  it('file not in the box: not_in_box (relocation follows)', async () => {
    const { portal, db } = setup();
    const r = db.addRow({ name: 'r', bytes: bytesOf('paper'), state: 'restore_pending', crmCopy: false, bitrixFileId: 77 });
    await processFileMoveBatch(deps(db, portal, { maxJobs: 1 }));
    expect(r.relocateDue).toBe(true);
    expect(r.lastCode).toBe('not_in_box');
  });
});

describe('relocation and presence', () => {
  it('relocate: an unknown entry with our bytes is reported; the database compares', async () => {
    const { portal, db } = setup();
    const bytes = bytesOf('lost id');
    const known = portal.put(DEAL, IDENTITY_BOX, bytesOf('known'));
    db.addRow({ name: 'k', bytes: bytesOf('known'), state: 'verified', bitrixFileId: known, deleteAfter: db.now + HOLD_MS });
    const stranger = portal.put(DEAL, IDENTITY_BOX, bytesOf('a staff upload'));
    const moved = portal.put(DEAL, IDENTITY_BOX, bytes);
    const r = db.addRow({ name: 'r', bytes, state: 'deleted', crmCopy: false, bitrixFileId: 77, relocateDue: true });
    const run = await processFileMoveBatch(deps(db, portal, { maxJobs: 1 }));
    expect(run.done).toEqual({ relocated: 1 });
    expect(r.bitrixFileId).toBe(moved);
    // The known file is never downloaded as a candidate.
    expect(portal.log).toEqual(['read', `download ${stranger}`, `download ${moved}`]);
  });

  it('relocate: no match is not_in_box; an unreadable candidate is a retry', async () => {
    const { portal, db } = setup();
    portal.put(DEAL, IDENTITY_BOX, bytesOf('a staff upload'));
    const r = db.addRow({ name: 'r', bytes: bytesOf('lost'), state: 'deleted', crmCopy: false, bitrixFileId: 77, relocateDue: true });
    await processFileMoveBatch(deps(db, portal, { maxJobs: 1 }));
    expect(r.lastCode).toBe('no_matching_file');
    db.now += 181_000;
    portal.failDownloads = true;
    await processFileMoveBatch(deps(db, portal, { maxJobs: 1 }));
    expect(r.lastCode).toBe('relocate_unreadable');
  });

  it('presence: one read, every id in the box reported; deal not found reports null; Bitrix down reports nothing', async () => {
    const { portal, db } = setup();
    const a = portal.put(DEAL, IDENTITY_BOX, bytesOf('a'));
    const b = portal.put(DEAL, IDENTITY_BOX, bytesOf('b'));
    db.presenceDue = { deal: DEAL, box: IDENTITY_BOX };
    expect((await processFileMoveBatch(deps(db, portal))).done).toEqual({ presence_checked: 1 });
    expect(db.presenceCalls).toEqual([[a, b]]);
    expect(portal.log).toEqual(['read']);

    // Deal unknown to Bitrix: null (the database opens the alert).
    db.presenceDue = { deal: '777', box: IDENTITY_BOX };
    await processFileMoveBatch(deps(db, portal));
    expect(db.presenceCalls).toEqual([[a, b], null]);

    db.presenceDue = { deal: DEAL, box: IDENTITY_BOX };
    portal.readFailures = ['down'];
    expect(await processFileMoveBatch(deps(db, portal))).toMatchObject({ endedBy: 'bitrix_unavailable', done: { presence_failed: 1 } });
    expect(db.presenceCalls).toHaveLength(2);
  });

  it('deal not found on a check: deal_not_found, never a deletion', async () => {
    const { portal, db } = setup();
    const r = db.addRow({ name: 'r', bytes: bytesOf('paper'), state: 'copied', bitrixFileId: 5, deal: '777' });
    await processFileMoveBatch(deps(db, portal));
    expect(r.lastCode).toBe('deal_not_found');
    expect(db.removed).toEqual([]);
  });
});

describe('time, credentials and box rules', () => {
  it('time left is checked before each claim (one step needs up to 60 s)', async () => {
    const { portal, db } = setup();
    db.addRow({ name: 'r', bytes: bytesOf('paper') });
    const run = await processFileMoveBatch(deps(db, portal, { deadline: db.now + FILE_MOVE_STEP_WORST_CASE_MS - 1 }));
    expect(run).toMatchObject({ claimed: 0, endedBy: 'time' });
    expect(db.trail).toEqual([]);
  });

  it('out of time after the claim, before the first Bitrix call: released untouched', async () => {
    const { portal, db } = setup();
    const r = db.addRow({ name: 'r', bytes: bytesOf('paper') });
    const run = await processFileMoveBatch(
      deps(db, portal, {
        deadline: db.now + FILE_MOVE_STEP_WORST_CASE_MS + 1_000,
        claim: async () => {
          const job = db.claim();
          db.now += 2_000;
          return job;
        },
      }),
    );
    expect(run).toMatchObject({ claimed: 1, endedBy: 'time', done: { released: 1 } });
    expect(r.state).toBe('copy_pending');
    expect(portal.log).toEqual([]);
  });

  it('no write credential: copies wait (retry), checks still run, nothing else is called', async () => {
    const { portal, db } = setup();
    const r = db.addRow({ name: 'r', bytes: bytesOf('paper') });
    const run = await processFileMoveBatch(deps(db, portal, { noWriter: true }));
    expect(run).toMatchObject({ endedBy: 'write_not_configured', done: { retry: 1 } });
    expect(r.lastCode).toBe('write_credential_missing');
    expect(portal.log).toEqual([]);
    const bytes = bytesOf('copied one');
    const id = portal.put(DEAL, IDENTITY_BOX, bytes);
    const c = db.addRow({ name: 'c', bytes, state: 'copied', bitrixFileId: id });
    await processFileMoveBatch(deps(db, portal, { noWriter: true }));
    expect(c.state).toBe('verified');
  });

  it('a row whose box does not fit its class is never sent', async () => {
    const { portal, db } = setup();
    const r = db.addRow({ name: 'r', bytes: bytesOf('paper'), box: ACCOUNTS_BOX, fileClass: 'id_proof' });
    const s = db.addRow({ name: 's', bytes: bytesOf('paper2'), box: IDENTITY_BOX, fileClass: 'accounts' });
    await processFileMoveBatch(deps(db, portal));
    expect([r.lastCode, s.lastCode]).toEqual(['box_not_allowed', 'box_not_allowed']);
    expect(portal.log).toEqual([]);
  });

  it('a failed claim ends the batch with a code', async () => {
    const { portal, db } = setup();
    const run = await processFileMoveBatch(
      deps(db, portal, {
        claim: async () => {
          throw new FileMoveCommandError('file_move_claim', '08006', 'other');
        },
      }),
    );
    expect(run).toEqual({ claimed: 0, done: {}, stopped: false, endedBy: 'db_error', errors: ['claim_failed'] });
  });
});

// ---------------------------------------------------------------------------
// The command wrappers (zod-checked; codes only)
// ---------------------------------------------------------------------------

describe('file-move-commands', () => {
  const rowJob = {
    moveId: '11111111-1111-4111-8111-111111111111',
    leaseToken: '22222222-2222-4222-8222-222222222222',
    mode: 'verify',
    fileClass: 'accounts',
    sourceTable: 'finance_evidence',
    kindCode: 'bank',
    bitrixDealId: '501',
    bitrixField: ACCOUNTS_BOX,
    bucket: 'finance-evidence',
    objectPath: 'e/f',
    mime: 'application/pdf',
    sizeBytes: 10,
    sha256: 'a'.repeat(64),
    bitrixFileId: '901',
    priorFileIds: ['11', 12],
    knownFileIds: [],
    attempts: 0,
  };
  const client = (data: unknown, error: { code?: string; message?: string } | null = null) => {
    const calls: Array<{ fn: string; args: Record<string, unknown> | undefined }> = [];
    const rpc: RpcClient = {
      rpc: async (fn, args) => {
        calls.push({ fn, args });
        return { data, error };
      },
    };
    return { rpc, calls };
  };

  it('claim parses row and presence jobs (ids as numbers), limit 1 and lease 180 by default', async () => {
    const presence = { moveId: null, leaseToken: '33333333-3333-4333-8333-333333333333', mode: 'presence', bitrixDealId: '501', bitrixField: IDENTITY_BOX, expectedFileIds: ['901'] };
    const c = client([rowJob, presence]);
    const jobs = await claimFileMoves(c.rpc);
    expect(c.calls).toEqual([{ fn: 'file_move_claim', args: { p_limit: 1, p_lease_seconds: 180 } }]);
    expect(jobs[0]).toMatchObject({ mode: 'verify', bitrixFileId: 901, priorFileIds: [11, 12] });
    expect(jobs[1]).toMatchObject({ mode: 'presence', expectedFileIds: [901] });
  });

  it('claim keeps the lease start the database wrote (microseconds and offset); a job without one still parses', async () => {
    const leasedAt = '2026-12-01T10:00:00.123456+00:00';
    const jobs = await claimFileMoves(client([{ ...rowJob, leasedAt }, rowJob]).rpc);
    expect(jobs[0]).toMatchObject({ leasedAt });
    expect(Date.parse((jobs[0] as FileMoveRowJob).leasedAt!)).toBe(Date.parse('2026-12-01T10:00:00.123Z'));
    expect((jobs[1] as FileMoveRowJob).leasedAt).toBeUndefined();
  });

  it('confirm_restored passes the read-back hash and size; lease_ok passes the minimum seconds; odd answers fail closed', async () => {
    const restored = client({ result: 'missing' });
    expect(await confirmFileMoveRestored(restored.rpc, rowJob, { sha256: 'c'.repeat(64), sizeBytes: 10 })).toBe('missing');
    expect(restored.calls).toEqual([{ fn: 'file_move_confirm_restored',
      args: { p_id: rowJob.moveId, p_lease_token: rowJob.leaseToken, p_stored_sha256: 'c'.repeat(64), p_stored_size: 10 } }]);
    await expect(confirmFileMoveRestored(client({ result: 'matched' }).rpc, rowJob, { sha256: 'c'.repeat(64), sizeBytes: 10 }))
      .rejects.toBeInstanceOf(FileMoveCommandError);
    for (const ok of [true, false]) {
      const lease = client({ ok });
      expect(await fileMoveLeaseOk(lease.rpc, rowJob, 60)).toBe(ok);
      expect(lease.calls).toEqual([{ fn: 'file_move_lease_ok', args: { p_id: rowJob.moveId, p_lease_token: rowJob.leaseToken, p_min_seconds: 60 } }]);
    }
    for (const bad of [{ ok: 'yes' }, null, { result: 'ok' }]) {
      await expect(fileMoveLeaseOk(client(bad).rpc, rowJob, 60)).rejects.toBeInstanceOf(FileMoveCommandError);
    }
  });

  it('an unexpected job fails closed', async () => {
    for (const bad of [{ ...rowJob, mime: 'text/html' }, { ...rowJob, mode: 'erase' }, { ...rowJob, bitrixField: 'title' }, { ...rowJob, sizeBytes: 5_000_000 },
      { ...rowJob, leasedAt: 'not a time' }]) {
      await expect(claimFileMoves(client([bad]).rpc)).rejects.toBeInstanceOf(FileMoveCommandError);
    }
  });

  it('refusals map to fixed codes; the database message never reaches the error', async () => {
    const c = client(null, { code: 'PT409', message: 'task_conflict for p_id 11111111' });
    const e = await completeFileMove(c.rpc, rowJob, 'retry', 'bitrix_unavailable').catch((x: unknown) => x);
    expect(e).toMatchObject({ refusal: 'task_conflict', sqlState: 'PT409' });
    expect(String(e)).not.toContain('11111111');
  });

  it('complete checks codes before calling (letters and underscores only; required except copied and released)', async () => {
    const c = client({ moveId: rowJob.moveId, state: 'copied', attempts: 1 });
    await expect(completeFileMove(c.rpc, rowJob, 'retry', 'http_5xx')).rejects.toMatchObject({ refusal: 'invalid_input' });
    await expect(completeFileMove(c.rpc, rowJob, 'retry', null)).rejects.toMatchObject({ refusal: 'invalid_input' });
    await expect(completeFileMove(c.rpc, rowJob, 'copied', null, null)).rejects.toMatchObject({ refusal: 'invalid_input' });
    expect(c.calls).toHaveLength(0);
    await completeFileMove(c.rpc, rowJob, 'copied', null, 901);
    expect(c.calls[0]).toEqual({ fn: 'file_move_complete', args: { p_id: rowJob.moveId, p_lease_token: rowJob.leaseToken, p_outcome: 'copied', p_error_code: null, p_bitrix_file_id: 901 } });
  });

  it('record_observation hands over what was observed, including when the read started', async () => {
    const c = client({ result: 'retry' });
    const result = await recordFileMoveObservation(c.rpc, rowJob, { bitrixFileId: 901, sha256: 'b'.repeat(64), sizeBytes: 10, readStartedAt: '2026-12-01T10:00:00.000Z' });
    expect(result).toBe('retry');
    expect(c.calls[0]!.args).toEqual({
      p_id: rowJob.moveId,
      p_lease_token: rowJob.leaseToken,
      p_bitrix_file_id: 901,
      p_observed_sha256: 'b'.repeat(64),
      p_observed_size: 10,
      p_read_started_at: '2026-12-01T10:00:00.000Z',
    });
    await expect(recordFileMoveObservation(client({ result: 'matched' }).rpc, rowJob, { bitrixFileId: 1, sha256: 'b'.repeat(64), sizeBytes: 1, readStartedAt: 'x' })).rejects.toBeInstanceOf(FileMoveCommandError);
  });
});

// ---------------------------------------------------------------------------
// The worker endpoint: ?task=files
// ---------------------------------------------------------------------------

describe('worker endpoint ?task=files', () => {
  const WORKER_BEARER = 'synthetic-worker-secret-0123456789abcdef';
  const START = 1_000_000;
  const configRow = {
    portal_domain: PORTAL,
    portal_member_id: 'synthetic-member',
    category_id: '7',
    eligible_stage_ids: ['C7:WON'],
    cutoff_at: '2026-10-01T00:00:00+05:30',
    enabled: true,
  };
  const RAN: FileMoveResult = { status: 'ran', claimed: 2, done: { copied: 1, verified: 1 }, stopped: false, endedBy: 'no_work', errors: [] };

  function endpointDeps(over: Partial<WorkerEndpointDeps> = {}): WorkerEndpointDeps & { schedule: ReturnType<typeof vi.fn>; fetchImpl: typeof fetch } {
    const schedule = vi.fn();
    const fetchImpl = vi.fn(async () => new Response('{}')) as unknown as typeof fetch;
    return {
      env: { bitrixWebhookBaseUrl: READ_BASE, bitrixEventApplicationToken: null, intakeWorkerSecret: WORKER_BEARER, cronSecret: null },
      appEnv: 'local',
      loadConfigRows: async () => [configRow],
      rpc: () => asRpcClient({ rpc: async () => ({ data: null, error: null }) }),
      now: () => START,
      fetchImpl,
      schedule,
      ...over,
    } as WorkerEndpointDeps & { schedule: ReturnType<typeof vi.fn>; fetchImpl: typeof fetch };
  }
  const req = (task: string, auth: string | null = `Bearer ${WORKER_BEARER}`) =>
    new Request(`https://crm.example.test/api/integrations/bitrix/worker?task=${task}`, { method: 'POST', headers: auth ? { authorization: auth } : {} });

  it('needs the worker bearer', async () => {
    const fileMove = vi.fn(async () => RAN);
    for (const auth of [null, 'Bearer wrong-secret-0123456789abcdefghijkl']) {
      const res = await handleWorkerRequest(req('files', auth), endpointDeps({ fileMove }));
      expect(res.status).toBe(401);
    }
    expect(fileMove).not.toHaveBeenCalled();
  });

  it('an unknown task is still 400', async () => {
    const fileMove = vi.fn(async () => RAN);
    const res = await handleWorkerRequest(req('filez'), endpointDeps({ fileMove }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
    expect(fileMove).not.toHaveBeenCalled();
  });

  it('runs the file move within the budget minus the alert margin; codes and counts only; the alert check follows; no Bitrix call of its own', async () => {
    const fileMove = vi.fn<(input: { config: IntakeConfig; deadline: number }) => Promise<FileMoveResult>>(async () => RAN);
    const d = endpointDeps({ fileMove });
    const res = await handleWorkerRequest(req('files'), d);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(RAN);
    expect(fileMove).toHaveBeenCalledTimes(1);
    expect(fileMove.mock.calls[0]![0]).toMatchObject({ config: { portalDomain: PORTAL }, deadline: START + WORKER_INVOCATION_BUDGET_MS - ALERT_CHECK_MARGIN_MS });
    expect(d.schedule).toHaveBeenCalledTimes(1);
    expect(d.fetchImpl).not.toHaveBeenCalled();

    const custom = vi.fn(async () => RAN);
    await handleWorkerRequest(req('files'), endpointDeps({ fileMove: custom, invocationBudgetMs: 50_000 }));
    expect(custom.mock.calls[0]).toEqual([expect.objectContaining({ deadline: START + 50_000 - ALERT_CHECK_MARGIN_MS })]);
  });

  it('not wired, no active config, not configured, or a failure: fixed answers, alert check still scheduled', async () => {
    const none = endpointDeps();
    expect((await handleWorkerRequest(req('files'), none)).status).toBe(503);
    expect(none.schedule).toHaveBeenCalledTimes(1);

    const noConfig = vi.fn(async () => RAN);
    const res = await handleWorkerRequest(req('files'), endpointDeps({ fileMove: noConfig, loadConfigRows: async () => [] }));
    expect(res.status).toBe(503);
    expect(noConfig).not.toHaveBeenCalled();

    const notConfigured = await handleWorkerRequest(req('files'), endpointDeps({ fileMove: async () => ({ status: 'not_configured', code: 'bitrix_target_invalid' }) }));
    expect(notConfigured.status).toBe(503);
    expect(await notConfigured.json()).toEqual({ error: 'not_configured', code: 'bitrix_target_invalid' });

    const failing = await handleWorkerRequest(
      req('files'),
      endpointDeps({
        fileMove: async () => {
          throw new Error(`synthetic failure ${READ_BASE}`);
        },
      }),
    );
    expect(failing.status).toBe(500);
    const body = JSON.stringify(await failing.json());
    expect(body).toBe('{"error":"internal_error"}');
  });
});
