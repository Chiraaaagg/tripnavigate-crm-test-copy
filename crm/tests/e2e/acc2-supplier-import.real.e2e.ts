import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  USERS, type UserKey, asUser, configured, entityId, noServiceWorker, outbound, prepareUsers, q, restoreSwitches, saveSwitches, session, sha, switchesOn,
} from './acc2-real-support';

/**
 * Accounts Phase 2 test plan 12.4 journey 3 "Supplier import", Track F:
 * stage the owner-file sample (synthetic, supabase/fixtures/imports) on
 * Settings › Imports › Suppliers → preview with warnings (bank values masked)
 * → dry run → apply with a reason → bank details held → the Manager approves
 * → no longer on hold; re-import updates by source reference, a verified
 * supplier is skipped. Item 5: no outbound request, no service worker.
 *
 * The sample's TST- suppliers stay on the stack (rows are never deleted): the
 * journey expects a clean stack (the final gate resets it first).
 */

test.describe.configure({ mode: 'serial' });
test.skip(!configured, 'needs the real local stack (TEST_DATABASE_URL, Supabase URL and keys)');

const OWNER_FILE = join(import.meta.dirname, '..', '..', 'supabase', 'fixtures', 'imports', 'acc2-supplier-owner-file.csv');
let secrets: Record<UserKey, string>;
test.beforeAll(async () => {
  await saveSwitches();
  secrets = await prepareUsers();
  await switchesOn();
});
test.afterAll(async () => {
  await restoreSwitches();
});

test('3. supplier import: preview, dry run, apply, bank held until the Manager approves; re-import by source reference', async ({ browser }) => {
  const acc = await session(browser, 'accA', secrets);
  await acc.page.goto('/app/admin/imports?kind=supplier');
  await acc.page.getByLabel('CSV file').setInputFiles(OWNER_FILE);
  await acc.page.getByRole('button', { name: 'Check file' }).click();
  // Preview with warnings (the check is the dry run); bank account numbers never shown in full.
  await expect(acc.page.getByText(/TST-S-001/).first()).toBeVisible({ timeout: 30_000 });
  const previewText = (await acc.page.locator('body').innerText()).replace(/\s+/g, ' ');
  expect(previewText).not.toContain('100000000001');
  // Apply with a reason; rows with bank details need the same file again (review fix A 0140).
  await acc.page.getByRole('button', { name: /Apply import/ }).first().click();
  const dialog = acc.page.getByRole('dialog', { name: 'Apply this import?' });
  await dialog.getByLabel('Reason').fill('Synthetic: supplier import journey (local stack)');
  const again = dialog.getByLabel('The same CSV file');
  if (await again.count()) await again.setInputFiles(OWNER_FILE);
  await dialog.getByRole('button', { name: 'Apply import' }).click();
  await expect.poll(async () => (await q<{ n: number }>(`select count(*)::int as n from public.suppliers where source_ref = 'TST-S-003'`))[0]!.n).toBe(1);
  // TST-S-001 is in the sample twice (duplicate_in_file, never created); TST-S-003 carries bank details.
  const [s1] = await q<{ id: string; verification_status: string }>(`select id, verification_status from public.suppliers where source_ref = 'TST-S-003'`);
  expect(s1!.verification_status).toBe('unverified');
  // Bank details arrive unverified: payments held until a Manager who is not the applier approves.
  expect((await q<{ ok: boolean }>('select authz.sm_bank_approved($1) as ok', [s1!.id]))[0]!.ok).toBe(false);
  const [rev] = await q<{ revision_no: number; created_by: string }>(
    'select revision_no, created_by from public.supplier_beneficiary_revisions where supplier_id = $1 order by revision_no desc limit 1', [s1!.id]);
  expect(rev!.created_by).toBe(USERS.accA.id);
  // Staged account numbers are masked after apply.
  expect(JSON.stringify(await q(`select r.data from public.import_rows r join public.import_batches b on b.id = r.batch_id
    where b.kind = 'supplier' and r.data::text like '%TST-S-003%'`))).not.toContain('100000000003');
  const mgr = await session(browser, 'manager', secrets);
  await mgr.page.goto(`/app/purchase/suppliers`);
  await asUser(USERS.manager.id, 'select public.supplier_approve_beneficiary($1, $2) as r', [s1!.id, rev!.revision_no]);
  expect((await q<{ ok: boolean }>('select authz.sm_bank_approved($1) as ok', [s1!.id]))[0]!.ok).toBe(true);
  await mgr.ctx.close();

  // Re-import (database command the screen calls): TST-S-003 changed → update; a verified supplier → skipped.
  const [s2] = await q<{ id: string; row_version: number }>(`select id, row_version from public.suppliers where source_ref = 'TST-S-002'`);
  await asUser(USERS.manager.id, 'select public.supplier_verify($1, $2) as r', [s2!.id, s2!.row_version]);
  const rows = [
    { sourceRef: 'TST-S-003', name: 'Test Cab Services', supplierKind: 'direct', serviceTypes: 'transfer', city: 'Jodhpur', pan: 'AAAAA0003A',
      address: '3 Test Cab Lane (new)' },
    { sourceRef: 'TST-S-002', name: 'Test Desert Tours Renamed', supplierKind: 'channel', serviceTypes: 'hotel;transfer', city: 'Jaisalmer' },
  ];
  const staged = await asUser<{ batchId: string }>(USERS.accA.id, 'select public.import_batch_stage($1, $2, $3, $4, $5, $6::jsonb, $7) as r',
    [await entityId(), 'supplier', null, 'synthetic re-import.csv', sha(), JSON.stringify(rows), randomUUID()]);
  const v = await asUser<{ rowVersion: number; proposalHash: string }>(USERS.accA.id, 'select public.import_batch_validate($1) as r', [staged.batchId]);
  const got = await asUser<{ rows: Array<{ sourceRef: string; outcome: string }> }>(USERS.accA.id, 'select public.import_batch_get($1, $2, $3) as r',
    [staged.batchId, 100, 0]);
  expect(Object.fromEntries(got.rows.map((r) => [r.sourceRef, r.outcome]))).toEqual({ 'TST-S-003': 'update', 'TST-S-002': 'skipped_checked' });
  await asUser(USERS.accA.id, 'select public.import_batch_apply($1, $2, $3, $4) as r', [staged.batchId, v.rowVersion,
    'Synthetic: supplier re-import (local stack)', v.proposalHash]);
  expect((await q<{ name: string }>(`select name from public.suppliers where source_ref = 'TST-S-002'`))[0]!.name).toBe('Test Desert Tours');
  await noServiceWorker(acc.page);
  await acc.ctx.close();
});

test('5. no outbound request to any other host during the run', () => {
  expect(outbound).toEqual([]);
});
