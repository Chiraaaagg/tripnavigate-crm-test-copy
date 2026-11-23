import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { DEAL, MANAGER, OWNER, SQL, VISA_A, rid, visaHelpers } from './visa-e-support';

/**
 * Visa build (contract 8 Nov 2026) scope item 15: one database assertion per
 * live defect the build fixes (D1, D2, D3, D5; D4 is not a defect, 10.3).
 * The detailed cases live in the other visa-*.test.ts suites; these are the
 * defect-to-test traceability checks.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = visaHelpers(() => db);
const { one, stickerTask, app, makeReady } = h;

describe('live defects D1-D5', () => {
  it('D1: the checklist can be filled (Sales documents seeded, ticked received, passenger ready)', async () => {
    await asOwner(db, async () => {
      const { taskId } = await stickerTask();
      expect((await app(taskId, 1)).documentsTotal).toBe(3);
      expect((await makeReady(taskId, 1)).ready).toBe(true);
    });
  });

  it('D2: the branch Manager can open the visa task (read-only)', async () => {
    await asOwner(db, async () => {
      const { taskId } = await stickerTask();
      expect(await h.workspace(taskId, MANAGER)).toMatchObject({ taskId, isManagerView: true, canWork: false });
    });
  });

  it('D3: a removed traveller number is never reused on the Deal', async () => {
    await asOwner(db, async () => {
      const s = await stickerTask();
      const v2 = await h.revise(s.versionId, async (versionId, rv) => {
        const next = (await h.saveTravellers(OWNER, DEAL, rv, [
          { fullName: 'Synthetic Traveller One', type: 'adult', seq: 1 }, { fullName: 'Synthetic Traveller Two', type: 'adult', seq: 2 },
          { fullName: 'Synthetic Traveller Three', type: 'adult', seq: 3 }])).rowVersion;
        return (await h.saveParticipation(OWNER, s.itemIds[0]!, versionId, next, [1, 2, 3])).rowVersion;
      });
      await one({ userId: 'a0000000-0000-4000-8000-000000000006' }, SQL.reviewReturn, [v2, 'Synthetic return: number reuse', rid()]);
      const opened = await one<{ rowVersion: number }>(OWNER, SQL.openRevision, [v2]);
      await h.refused(OWNER, SQL.travellers, [DEAL, opened.rowVersion, JSON.stringify([{ fullName: 'Synthetic Someone Else', type: 'adult', seq: 4 }])],
        'traveller_seq_reused', '22023');
    });
  });

  it('D5: a decision creates a notice for the Deal\'s Sales owner', async () => {
    await asOwner(db, async () => {
      const { taskId } = await stickerTask();
      const a = await h.appliedAlone(taskId, 1);
      await h.decide(taskId, a, 'approved');
      const summary = await one<{ notices: Array<{ outcome: string; canAck: boolean }> }>(OWNER, SQL.dealSummary, [DEAL]);
      expect(summary.notices).toEqual([expect.objectContaining({ outcome: 'approved', canAck: true })]);
      expect(VISA_A.userId).toBeTruthy();
    });
  });
});
