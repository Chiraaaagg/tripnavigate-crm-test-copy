import { z } from 'zod';
import { forbiddenKeyPaths } from '@/modules/documents/guard';
import { scanStrings, type SafetyHit } from '@/modules/documents/safety';
import { DOCUMENT_CODES, DOCUMENT_KINDS, DOCUMENT_TITLES, type DocumentKind } from './contracts';

/**
 * Frozen content of a customer document (contract 6.4, schema cdoc-1) and
 * the pure helpers around it: number format, titles, rupee words and the
 * pre-print checks (forbidden key names and the content-safety scan). Pure.
 *
 * The database builds the content (authz.cdoc_build) and freezes it at
 * release; this schema is the read side (every key listed). No "not a tax
 * invoice" line (owner answer Q1).
 */

const paise = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = (max: number) => z.string().min(1).max(max);

export const ContentLineSchema = z.object({ label: text(200), amountPaise: paise }).strict();

export const CustomerDocumentContentSchema = z
  .object({
    schema: z.literal('cdoc-1'),
    kind: z.enum(DOCUMENT_KINDS),
    title: z.enum(['Advance Invoice', 'Invoice', 'Credit Note']),
    number: z.string().regex(/^.{1,40}-(ADV|INV|CN)-[0-9]{1,4}$/).nullable(),
    issueDate: isoDate.nullable(),
    company: z
      .object({
        legalName: text(200),
        registeredAddress: text(300),
        pan: z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/),
        gstin: text(40),
        gstinState: text(60).nullable(),
      })
      .strict(),
    branch: z.object({ code: text(16).nullable(), name: text(120).nullable() }).strict(),
    customer: z
      .object({
        billingName: text(200),
        addressLine1: text(200),
        addressLine2: text(200).nullable(),
        city: text(120),
        stateCode: z.string().regex(/^[0-9]{2}$/),
        postalCode: z.string().regex(/^[1-9][0-9]{5}$/),
        gstin: z.string().nullable(),
      })
      .strict()
      .nullable(),
    deal: z.object({ reference: text(80), dealNumber: z.string().regex(/^[1-9][0-9]{0,18}$/).nullable() }).strict(),
    trip: z
      .object({
        destination: text(200).nullable(),
        startDate: isoDate.nullable(),
        endDate: isoDate.nullable(),
        travellerCount: z.number().int().min(0).max(1000).nullable(),
      })
      .strict(),
    lines: z.array(ContentLineSchema).min(1).max(50),
    totalPaise: paise,
    paidPaise: paise,
    balancePaise: paise.optional(),
    plan: z.array(z.object({ label: text(60), dueDate: isoDate, amountPaise: paise }).strict()).min(1).max(12).optional(),
    payment: z.object({ reference: text(40), receivedOn: isoDate, mode: z.enum(['bank_transfer', 'upi', 'cash', 'cheque']) }).strict().nullable(),
    credits: z.object({ number: text(60), title: text(40) }).strict().nullable(),
    gstInvoiceNumber: text(40).nullable(),
    replaces: z.object({ number: text(60) }).strict().nullable(),
  })
  .strict();
export type CustomerDocumentContent = z.infer<typeof CustomerDocumentContentSchema>;

export function documentTitle(kind: DocumentKind): string {
  return DOCUMENT_TITLES[kind];
}

/** "<prefix>-<CODE>-<seq>" (contract 6.3), e.g. 10101-INV-1; prefix = Bitrix Deal id, else the CRM Deal reference. */
export function formatNumber(prefix: string, kind: DocumentKind, seq: number): string {
  if (!Number.isInteger(seq) || seq < 1 || seq > 9999) throw new RangeError('seq');
  const p = prefix.trim();
  if (p.length < 1 || p.length > 40) throw new RangeError('prefix');
  return `${p}-${DOCUMENT_CODES[kind]}-${seq}`;
}

/** The kind of a document number, or null when it is not one. */
export function numberKind(value: string): DocumentKind | null {
  const m = /^.{1,40}-(ADV|INV|CN)-[0-9]{1,4}$/.exec(value);
  if (!m) return null;
  return (Object.keys(DOCUMENT_CODES) as DocumentKind[]).find((k) => DOCUMENT_CODES[k] === m[1]) ?? null;
}

/** Whole paise -> "₹25,000.00" (Indian grouping, always two decimals). Exact; no floats. */
export function formatRupees(value: string): string {
  if (!/^(0|[1-9][0-9]{0,17})$/.test(value)) throw new RangeError('paise');
  const p = BigInt(value);
  const rupees = (p / 100n).toString();
  const decimals = (p % 100n).toString().padStart(2, '0');
  const last3 = rupees.slice(-3);
  const rest = rupees.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `₹${grouped}.${decimals}`;
}

export const PAYMENT_MODE_WORDS: Readonly<Record<'bank_transfer' | 'upi' | 'cash' | 'cheque', string>> = Object.freeze({
  bank_transfer: 'Bank transfer',
  upi: 'UPI',
  cash: 'Cash',
  cheque: 'Cheque',
});

/** The Deal line printed on the document: the Bitrix Deal id when known ("Deal ID 10101"), else the CRM reference. */
export function dealLine(content: Pick<CustomerDocumentContent, 'deal'>): { label: 'Deal ID' | 'Deal reference'; value: string } {
  return content.deal.dealNumber ? { label: 'Deal ID', value: content.deal.dealNumber } : { label: 'Deal reference', value: content.deal.reference };
}

/** What prints: the content without the CRM reference when the Bitrix Deal id is printed instead. */
export function printedContent(content: CustomerDocumentContent): Record<string, unknown> {
  if (!content.deal.dealNumber) return content;
  return { ...content, deal: { dealNumber: content.deal.dealNumber } };
}

export type ContentCheck =
  | { ok: true; content: CustomerDocumentContent }
  | { ok: false; code: 'input_invalid'; issue: string }
  | { ok: false; code: 'forbidden_field'; paths: string[] }
  | { ok: false; code: 'content_safety'; hits: SafetyHit[] };

/**
 * The checks before a preview or a PDF (contract 6.4): the cdoc-1 shape,
 * no forbidden key names at any depth, and the content-safety scan on every
 * printed string. Hits report list phrases and paths only.
 */
export function checkContent(value: unknown): ContentCheck {
  if (value && typeof value === 'object') {
    const paths = forbiddenKeyPaths(value);
    if (paths.length) return { ok: false, code: 'forbidden_field', paths };
  }
  const parsed = CustomerDocumentContentSchema.safeParse(value);
  if (!parsed.success) return { ok: false, code: 'input_invalid', issue: parsed.error.issues[0]?.path.join('.') || 'content' };
  const hits = scanStrings(printedContent(parsed.data));
  if (hits.length) return { ok: false, code: 'content_safety', hits };
  return { ok: true, content: parsed.data };
}

/** The PDF / print title ("Invoice 10101-INV-1"; a draft has no number yet). */
export function contentTitle(content: Pick<CustomerDocumentContent, 'title' | 'number'>): string {
  return content.number ? `${content.title} ${content.number}` : `${content.title} (draft)`;
}
