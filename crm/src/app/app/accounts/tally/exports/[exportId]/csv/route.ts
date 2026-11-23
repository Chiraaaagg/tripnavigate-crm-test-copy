import { tallyExportCsvResponse } from '@/modules/accounts-desk/server/export';

/**
 * CSV evidence pack of one Tally export (Accounts phase, contract 7.2/7.4):
 * Accounts of the export's entity only; one audit row per download; lines
 * streamed from their stored snapshots (PAN and mobile masked, formula-safe).
 * 404 for every refusal; never cached. Not a Tally import file.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ exportId: string }> }): Promise<Response> {
  const { exportId } = await ctx.params;
  return tallyExportCsvResponse(exportId);
}
