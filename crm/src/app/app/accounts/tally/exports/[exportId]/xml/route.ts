import { tallyFileXmlResponse } from '@/modules/accounts-desk/server/tally-xml-export';

/**
 * TallyPrime 7.1 import file of one Tally file (Accounts phase 3, contract 7.3): Accounts of the file's entity only;
 * one audit row per download (accounts.tally_file.downloaded); the XML is written from the frozen lines, so a
 * re-download gives the same bytes. 404 for every refusal; never cached. The CRM never contacts Tally.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ exportId: string }> }): Promise<Response> {
  const { exportId } = await ctx.params;
  return tallyFileXmlResponse(exportId);
}
