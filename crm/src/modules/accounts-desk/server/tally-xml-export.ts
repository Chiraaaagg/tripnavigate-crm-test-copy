import 'server-only';
import { z } from 'zod';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { requireStaff } from '@/modules/identity/server/session';
import { EXPORT_PAGE_SIZE } from '../contracts';
import { tallyFileDownloadLog, tallyFileLines } from '../tally-file';
import { tallyVoucherXml, tallyXmlFileName, tallyXmlHead, tallyXmlTail } from '../tally-xml';

/**
 * GET handler body for /app/accounts/tally/exports/[exportId]/xml (contract 7.3):
 *   1. requireStaff() (sign-in and MFA);
 *   2. accounts_tally_file_download_log under the staff member's own session: Accounts of the file's entity only,
 *      XML files only; one audit row per download; returns the frozen company name;
 *   3. the frozen lines are read page by page (accounts_tally_export_lines, 1,000 a page) and streamed as the
 *      TallyPrime import envelope (UTF-8 with a declaration).
 * Every refusal is an indistinguishable 404; the response is never cached. No network call to Tally.
 */

const NO_STORE = { 'Cache-Control': 'private, no-store, max-age=0', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { ...NO_STORE, 'Content-Type': 'text/plain; charset=utf-8' } });
}

export async function tallyFileXmlResponse(rawExportId: string): Promise<Response> {
  const staff = await requireStaff();
  const id = z.uuid().safeParse(rawExportId);
  if (!id.success) return notFound();
  const rpc = asRpcClient(staff.supabase);

  let header;
  try {
    header = await tallyFileDownloadLog(rpc, id.data);
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
        controller.enqueue(encoder.encode(tallyXmlHead(header.companyName)));
        return;
      }
      if (finished) {
        controller.close();
        return;
      }
      let page;
      try {
        page = await tallyFileLines(rpc, exportId, after, EXPORT_PAGE_SIZE);
      } catch {
        controller.error(new Error('file read failed'));
        return;
      }
      if (!page) {
        controller.error(new Error('file not readable'));
        return;
      }
      if (page.lines.length) {
        controller.enqueue(encoder.encode(page.lines.map((l) => tallyVoucherXml(l.values.voucher)).join('')));
        after = page.lines[page.lines.length - 1]!.lineNo;
      }
      if (page.nextAfter === null || page.lines.length === 0) {
        finished = true;
        controller.enqueue(encoder.encode(tallyXmlTail()));
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      ...NO_STORE,
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Disposition': `attachment; filename="${tallyXmlFileName(header.exportNo)}"`,
    },
  });
}
