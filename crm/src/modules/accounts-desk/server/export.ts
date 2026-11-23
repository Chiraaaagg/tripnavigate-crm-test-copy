import 'server-only';
import { z } from 'zod';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { requireStaff } from '@/modules/identity/server/session';
import { tallyExportDownloadLog, tallyExportLines } from '../commands';
import { EXPORT_PAGE_SIZE } from '../contracts';
import { CSV_BOM, csvFileName, csvHeaderLine, csvLine } from '../csv';

/**
 * GET handler body for /app/accounts/tally/exports/[exportId]/csv
 * (contract 7.2 T9/T10, 7.4):
 *   1. requireStaff() (sign-in and MFA);
 *   2. accounts_tally_export_download_log under the staff member's own
 *      session: Accounts of the export's entity only (never the Manager,
 *      Purchase, Flight or Visa); one audit row per download;
 *   3. the stored line snapshots are read page by page
 *      (accounts_tally_export_lines, 1,000 lines a page) and streamed as
 *      text/csv: UTF-8 with BOM, CRLF, RFC 4180 quoting, formula escaping,
 *      PAN and mobile masked (already masked in storage; masked again here).
 * Re-downloading an export reproduces the same file. Every refusal is an
 * indistinguishable 404; the response is never cached. The export never
 * marks anything matched in Tally.
 */

const NO_STORE = { 'Cache-Control': 'private, no-store, max-age=0', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { ...NO_STORE, 'Content-Type': 'text/plain; charset=utf-8' } });
}

export async function tallyExportCsvResponse(rawExportId: string): Promise<Response> {
  const staff = await requireStaff();
  const id = z.uuid().safeParse(rawExportId);
  if (!id.success) return notFound();
  const rpc = asRpcClient(staff.supabase);

  let header;
  try {
    header = await tallyExportDownloadLog(rpc, id.data);
  } catch {
    return notFound();
  }
  const exportId = id.data;
  const encoder = new TextEncoder();
  let after = 0;
  let started = false;
  let finished = false;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(encoder.encode(CSV_BOM + csvHeaderLine()));
        return;
      }
      if (finished) {
        controller.close();
        return;
      }
      let page;
      try {
        page = await tallyExportLines(rpc, exportId, after, EXPORT_PAGE_SIZE);
      } catch {
        controller.error(new Error('export read failed'));
        return;
      }
      if (!page) {
        controller.error(new Error('export not readable'));
        return;
      }
      if (page.lines.length) {
        controller.enqueue(encoder.encode(page.lines.map((l) => csvLine(l.values)).join('')));
        after = page.lines[page.lines.length - 1]!.lineNo;
      }
      if (page.nextAfter === null || page.lines.length === 0) finished = true;
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      ...NO_STORE,
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${csvFileName(header.exportNo)}"`,
    },
  });
}
