import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import {
  ACC, DEAL, FLIGHT, FLIGHT_2, LEG_JDH_DEL, MANAGER, MANAGER_AMD, OWNER, PURCHASE, SALES_B, SQL, VISA, flightHelpers, typedFlight,
} from './flight-support';

/**
 * Flight build, contract D9, L14 and section 6.1 A11; test plan 12.1
 * "Files": e-tickets are a new private department-evidence kind (PDF/image,
 * validated, 4 MiB, sha256) begun only by the Flight assignee; an e-ticket may
 * be opened by the Flight assignee, the Deal's Sales owner, the branch
 * Manager and Accounts of the entity; Purchase, Visa and other Sales are
 * refused; every download writes department.evidence_viewed. Payment proof
 * files never reach the Sales owner.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = flightHelpers(() => db);
const { one, owner, refused } = h;
const begin = (actor: typeof FLIGHT, task: string, kind: string, mime = 'application/pdf', size = 2048, sha = 'b'.repeat(64), name = 'e-ticket.pdf') =>
  h.attempt<{ evidenceId: string; objectPath: string }>(actor, SQL.evBegin, [task, null, kind, name, mime, size, sha]);

async function taken() {
  await h.addFlightPeople();
  const b = await h.packageDeal([{ type: 'flight', facts: typedFlight([LEG_JDH_DEL]) }]);
  await h.claim();
  return { b, task: b.flightTasks[0]! };
}

describe('e-tickets', () => {
  it('begin: Flight assignee only, flight kinds only, PDF/JPEG/PNG/WebP up to 4 MiB with a sha256', async () => {
    await asOwner(db, async () => {
      const { task } = await taken();
      for (const actor of [FLIGHT_2, OWNER, MANAGER, PURCHASE, ACC]) {
        const r = await begin(actor, task, 'e_ticket');
        expect(r.ok, `begin as ${actor.userId}`).toBe(false);
      }
      for (const kind of ['applicant_document', 'fee_receipt', 'authority_outcome', 'nonsense']) {
        expect((await begin(FLIGHT, task, kind)).ok, kind).toBe(false);
      }
      for (const [mime, name] of [['image/jpeg', 'e.jpg'], ['image/png', 'e.png'], ['image/webp', 'e.webp']]) {
        expect((await begin(FLIGHT, task, 'e_ticket', mime, 2048, 'b'.repeat(64), name)).ok, mime).toBe(true);
      }
      expect((await begin(FLIGHT, task, 'e_ticket', 'text/plain', 2048, 'b'.repeat(64), 'e.txt')).ok).toBe(false);
      expect((await begin(FLIGHT, task, 'e_ticket', 'application/pdf', 4 * 1024 * 1024 + 1)).ok).toBe(false);
      expect((await begin(FLIGHT, task, 'e_ticket', 'application/pdf', 2048, 'xyz')).ok).toBe(false);
      for (const kind of ['e_ticket', 'direct_payment_proof', 'other']) {
        expect((await begin(FLIGHT, task, kind)).ok, kind).toBe(true);
      }
    });
  });

  it('download: assignee, Sales owner, branch Manager, Accounts; never Purchase, Visa, other Sales; each view audited', async () => {
    await asOwner(db, async () => {
      const { task } = await taken();
      const eTicket = await h.evidence(FLIGHT, task, 'e_ticket');
      const proof = await h.evidence(FLIGHT, task, 'direct_payment_proof');
      for (const actor of [FLIGHT, OWNER, MANAGER, ACC]) {
        expect(await one(actor, SQL.evDownload, [eTicket]), `download as ${actor.userId}`).toBeTruthy();
      }
      for (const actor of [PURCHASE, VISA, SALES_B, MANAGER_AMD]) {
        const r = await h.attempt(actor, SQL.evDownload, [eTicket]);
        expect(r.ok && r.value !== null, `refused for ${actor.userId}`).toBe(false);
      }
      const views = await owner<{ n: number }>(`select count(*)::int as n from public.audit_events where action = 'department.evidence_viewed'`);
      expect(views[0]!.n).toBe(4);
      // The Sales owner never opens payment proofs.
      const r = await h.attempt(OWNER, SQL.evDownload, [proof]);
      expect(r.ok && r.value !== null).toBe(false);
      // Workspace and Deal page list the e-ticket (file name only, no object path).
      const ws = await one<{ eTickets: Array<{ evidenceId: string; fileName: string }> }>(FLIGHT, SQL.workspace, [DEAL]);
      expect(ws.eTickets).toEqual([expect.objectContaining({ evidenceId: eTicket, fileName: 'e_ticket.pdf' })]);
      for (const actor of [OWNER, MANAGER, ACC]) {
        const summary = await one<{ flights: Array<{ eTickets: Array<{ evidenceId: string }> }> }>(actor, SQL.dealSummary, [DEAL]);
        expect(summary.flights[0]!.eTickets.map((e) => e.evidenceId), `summary as ${actor.userId}`).toEqual([eTicket]);
      }
      expect(JSON.stringify(ws)).not.toMatch(/objectPath|department-evidence\//);
      await refused(OWNER, SQL.evBegin, [task, null, 'e_ticket', 'e.pdf', 'application/pdf', 2048, 'b'.repeat(64)], '(not_authorized|task_closed)');
    });
  });
});
