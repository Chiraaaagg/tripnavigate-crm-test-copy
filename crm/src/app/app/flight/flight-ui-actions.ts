'use server';

import { uploadDepartmentEvidenceAction } from '@/modules/fulfilment/server/department-actions';
import { uploadFlightETicketAction } from '@/modules/flight/server/actions';
import {
  confirmFlightTicketsAction,
  createFlightPaymentRequestAction,
  previewFlightFaresAction,
  requestFlightFareApprovalAction,
  saveFlightDirectPaymentAction,
} from '@/modules/flight/server/money-actions';
import { FM_FIELD } from '@/modules/flight/money-contracts';
import { createSupplierAction } from '@/modules/suppliers/server/actions';
import { requireStaff } from '@/modules/identity/server/session';

/*
 * Thin adapters between the Flight screens' forms and the server actions
 * whose field names differ (Track B's money actions read flat fields and a
 * `fareFields` JSON; the screens post one `payload` JSON). They only move
 * fields: every rule stays in the server actions and the database. The
 * workspace actions of Track A read the screens' fields directly and are
 * passed through by the route unchanged.
 *
 * Every adapter gates with requireStaff() first, before the posted payload
 * is parsed (security review go-live 1, P3-1): the proxy no longer stops
 * signed-out action calls, so nothing may run ahead of the gate. The inner
 * action gates again; requireStaff() is cached per request.
 */

type Result = { ok: true; data?: unknown; message: string } | { ok: false; code: string; message: string; fields?: string[] };

function payloadOf(formData: FormData): Record<string, unknown> {
  const raw = formData.get('payload');
  if (typeof raw !== 'string') return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function copy(formData: FormData, names: string[]): FormData {
  const out = new FormData();
  for (const n of names) {
    const v = formData.get(n);
    if (v !== null) out.set(n, v);
  }
  return out;
}

/** The fare set (preview and "Ask the Manager"): no ticket identifiers are sent, only each traveller's seq. */
function fareSet(p: Record<string, unknown>): Record<string, unknown> {
  const travellers = Array.isArray(p.travellers) ? (p.travellers as Array<Record<string, unknown>>) : [];
  return {
    sectorIds: p.sectorIds,
    supplierId: p.supplierId,
    fareApprovalId: (p.fareApprovalId as string | null | undefined) ?? null,
    fares: p.fares,
    travellers: travellers.map((t) => ({ seq: t.seq })),
  };
}

export async function flightFarePreviewUi(_prev: unknown, formData: FormData): Promise<Result> {
  await requireStaff();
  const dealId = formData.get('dealId');
  return previewFlightFaresAction(typeof dealId === 'string' ? dealId : '', fareSet(payloadOf(formData)));
}

export async function flightRequestFareApprovalUi(_prev: unknown, formData: FormData): Promise<Result> {
  await requireStaff();
  const fd = copy(formData, [FM_FIELD.dealId, FM_FIELD.requestId]);
  fd.set(FM_FIELD.fareFields, JSON.stringify(fareSet(payloadOf(formData))));
  return requestFlightFareApprovalAction(null, fd);
}

export async function flightConfirmTicketsUi(_prev: unknown, formData: FormData): Promise<Result> {
  await requireStaff();
  const fd = copy(formData, [FM_FIELD.dealId, FM_FIELD.requestId]);
  const p = payloadOf(formData);
  fd.set(FM_FIELD.fareFields, JSON.stringify({ ...p, fareApprovalId: (p.fareApprovalId as string | null | undefined) ?? null }));
  return confirmFlightTicketsAction(null, fd);
}

export async function flightDirectPaymentUi(_prev: unknown, formData: FormData): Promise<Result> {
  await requireStaff();
  const fd = copy(formData, [FM_FIELD.batchId, FM_FIELD.dealId, FM_FIELD.requestId]);
  const rv = formData.get(FM_FIELD.expectedRowVersion);
  // A first payment has no row version yet (the screens post 0 then).
  if (typeof rv === 'string' && rv !== '' && rv !== '0') fd.set(FM_FIELD.expectedRowVersion, rv);
  const p = payloadOf(formData);
  for (const k of [FM_FIELD.paymentMode, FM_FIELD.paidOn, FM_FIELD.reference, FM_FIELD.proofEvidenceId] as const) {
    const v = p[k];
    if (typeof v === 'string') fd.set(k, v);
  }
  return saveFlightDirectPaymentAction(null, fd);
}

export async function flightPaymentRequestUi(_prev: unknown, formData: FormData): Promise<Result> {
  await requireStaff();
  const fd = copy(formData, [FM_FIELD.batchId, FM_FIELD.paymentId, FM_FIELD.dealId, FM_FIELD.requestId]);
  const p = payloadOf(formData);
  for (const k of [FM_FIELD.dueDate, FM_FIELD.note, FM_FIELD.proformaEvidenceId] as const) {
    const v = p[k];
    if (typeof v === 'string') fd.set(k, v);
  }
  return createFlightPaymentRequestAction(null, fd);
}

export async function flightCreateSupplierUi(_prev: unknown, formData: FormData): Promise<Result> {
  await requireStaff();
  // Accounts phase 2 (contract 5.5 A3): a flight supplier is created through Track A's supplier action, which
  // routes a flight-only supplier to flight_supplier_create with the new kind, GSTIN, PAN and state fields.
  const fd = copy(formData, [FM_FIELD.requestId]);
  const p = payloadOf(formData);
  for (const k of ['name', 'city', 'contactName', 'contactPhone', 'contactEmail', 'supplierKind', 'gstin', 'pan', 'stateCode'] as const) {
    const v = p[k];
    if (typeof v === 'string' && v.trim() !== '') fd.set(k, v);
  }
  fd.set('serviceTypes', 'flight');
  const r = await createSupplierAction(null, fd);
  return r.ok ? { ok: true, message: r.message, data: r.data } : { ok: false, code: r.code, message: r.message, ...(r.field ? { fields: [r.field] } : {}) };
}

/** E-tickets go to the Flight e-ticket action; direct-payment proofs to the department evidence action. */
export async function flightUploadFileUi(_prev: unknown, formData: FormData): Promise<Result> {
  await requireStaff();
  const kind = formData.get('kind');
  if (kind === 'e_ticket') return uploadFlightETicketAction(null, formData);
  if (kind === 'direct_payment_proof') return uploadDepartmentEvidenceAction(null as never, formData);
  return { ok: false, code: 'invalid_input', message: 'Check the highlighted field.', fields: ['kind'] };
}
