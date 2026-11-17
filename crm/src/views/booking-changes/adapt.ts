import type { ChangeHistory, ChangePreview, ChangeRequestsPage as ModuleChangeRequestsPage, ChangeReview, DealChangeRequests, ReviewVersion, ServiceRemovalCharges, TaskReconfirmation } from '@/modules/booking-changes/dto';
import { fieldWord } from './labels';
import type { ChangeDepartment, ChangeHistoryView, ChangeModeView, ChangeRequestsPage, ChangeReviewView, DealChangeRequestsView, FactLine, RemovalChargesView, ReviewSideView, TaskReconfirmationView } from './types';

/*
 * Maps track G's read DTOs (`@/modules/booking-changes/dto`) onto the screen
 * types (contract 10.5). Pure; unit-tested in tests/unit/acc3u-changes-adapt.
 * Track H's additive keys (removalRoute, customerChargePaise, charges,
 * addableTypes, removable, serviceChangesEnabled, serviceBlockedBy) are
 * optional in the DTO: when absent the screens fall back to G's behaviour.
 */

const DEPARTMENTS: readonly ChangeDepartment[] = ['purchase', 'flight', 'visa', 'sales', 'accounts'];
const department = (d: string): ChangeDepartment => ((DEPARTMENTS as readonly string[]).includes(d) ? (d as ChangeDepartment) : 'purchase');
const who = (name: string | null) => name ?? 'A former staff member';

export function dealChangesView(d: DealChangeRequests): DealChangeRequestsView {
  return {
    dealId: d.dealId,
    enabled: d.enabled,
    // Track H: absent from an older server = service changes off (never guessed on).
    serviceChangesEnabled: d.serviceChangesEnabled ?? false,
    serviceBlockedBy: d.serviceBlockedBy,
    addableTypes: d.addableTypes,
    removable: d.removable?.map((s) => ({ itemId: s.itemId, itemNo: s.itemNo, serviceTitle: s.serviceTitle, department: department(s.department), booked: s.route === 'cancellation' })),
    canRequest: d.canRequest,
    blockedBy: d.blockedBy,
    confirmed: d.confirmed.map((c) => ({ ...c, department: department(c.department) })),
    requests: d.requests.map((r) => ({ ...r, requestedByName: who(r.requestedByName) })),
  };
}

/** R-H1 (Approver and Accounts): the supplier charges of a booked removal, per department line. */
export function removalChargesView(c: ServiceRemovalCharges): RemovalChargesView {
  return {
    changeRequestId: c.changeRequestId,
    refNo: c.refNo,
    customerChargePaise: c.customerChargePaise,
    services: c.charges.map((l) => ({
      itemNo: c.itemNo ?? 0,
      serviceTitle: l.label,
      department: department(l.department),
      supplierName: l.supplierName,
      supplierKeepsPaise: l.supplierKeepsPaise,
      refundExpectedPaise: l.refundExpectedPaise,
      enteredByName: l.enteredByName,
      complete: l.complete,
    })),
  };
}

export function changeRequestsPageView(p: ModuleChangeRequestsPage): ChangeRequestsPage {
  return { items: p.items.map((r) => ({ ...r, requestedByName: who(r.requestedByName) })), nextAfter: p.nextAfter, hasMore: p.hasMore };
}

/** Internal keys of a service's facts that mean nothing to staff (never shown). */
const HIDDEN_FACT_KEYS = new Set(['requestItems', 'entryMode', 'schema', 'schemaVersion']);

/** One fact value as plain words: lists joined, nested values flattened, yes / no; never raw JSON. */
export function factValueText(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (Array.isArray(v)) {
    const parts = v.map((x) => factValueText(x)).filter((x): x is string => x !== null);
    return parts.length ? parts.join(', ') : null;
  }
  if (typeof v === 'object') {
    const parts = Object.entries(v as Record<string, unknown>)
      .filter(([k]) => !HIDDEN_FACT_KEYS.has(k))
      .map(([k, x]) => {
        const t = factValueText(x);
        return t === null ? null : `${fieldWord(k)}: ${t}`;
      })
      .filter((x): x is string => x !== null);
    return parts.length ? parts.join('; ') : null;
  }
  return null;
}

/** Department-safe facts (already filtered by the DTO) as labelled lines, in a stable order; internal keys dropped. */
export function factLines(details: Readonly<Record<string, unknown>>): FactLine[] {
  return Object.keys(details)
    .filter((key) => !HIDDEN_FACT_KEYS.has(key))
    .sort()
    .map((key) => ({ key, label: fieldWord(key), value: factValueText(details[key]) }));
}

function reviewSide(v: ReviewVersion): ReviewSideView {
  return {
    versionNo: v.versionNo,
    tripStart: v.tripStart,
    tripEnd: v.tripEnd,
    sellingTotalPaise: v.sellingTotalPaise,
    plan: v.plan,
    services: v.services.map((s) => ({ itemId: s.itemId, itemNo: s.itemNo, serviceType: s.serviceType, serviceTitle: s.serviceTitle, facts: factLines(s.facts), budgetPaise: s.budgetPaise })),
  };
}

/** Addendum O2 (R-H2): the accepted booking and the change version side by side for the Manager. */
export function changeReviewView(r: ChangeReview): ChangeReviewView {
  return {
    changeRequestId: r.changeRequestId,
    refNo: r.refNo,
    kind: r.kind,
    status: r.status,
    rowVersion: r.rowVersion,
    removalRoute: r.removalRoute,
    customerChargePaise: r.customerChargePaise,
    base: reviewSide(r.base),
    proposed: r.proposed ? reviewSide(r.proposed) : null,
    changedItemIds: r.changedItemIds,
    changedFields: r.changedFields,
    sentVersionCurrent: r.sentVersionCurrent,
    canDecide: r.canDecide,
  };
}

export function taskReconfirmationView(t: TaskReconfirmation): TaskReconfirmationView {
  return {
    taskId: t.taskId,
    changeRequest: t.changeRequest,
    old: { details: factLines(t.old.details), ratePaise: t.old.ratePaise, reference: t.old.reference, confirmedAt: t.old.confirmedAt },
    new: { details: factLines(t.new.details), changedFields: t.new.changedFields },
    reconfirmation: {
      id: t.reconfirmation.id,
      status: t.reconfirmation.status,
      newRatePaise: t.reconfirmation.newRatePaise,
      supplierFeePaise: t.reconfirmation.supplierFeePaise,
      newReference: t.reconfirmation.newReference,
      evidenceId: t.reconfirmation.evidenceId,
      overBudget: t.reconfirmation.overBudget,
      budgetPaise: t.reconfirmation.budgetPaise,
      rowVersion: t.reconfirmation.rowVersion,
    },
    can: t.can,
  };
}

export function changeHistoryView(h: ChangeHistory): ChangeHistoryView {
  return {
    versions: h.versions.map((v) => ({
      ...v,
      changeRequest: v.changeRequest ? { ...v.changeRequest, requestedByName: who(v.changeRequest.requestedByName) } : null,
    })),
    confirmations: h.confirmations.map((c) => ({
      serviceTitle: c.serviceTitle,
      confirmationNo: c.confirmationNo,
      supplierName: c.supplierName,
      reference: c.reference,
      confirmedByName: c.confirmedByName,
      confirmedAt: c.confirmedAt,
      amountPaise: c.amountPaise ?? null,
      changeFeePaise: c.changeFeePaise ?? null,
    })),
  };
}

/** The change-mode banner data, or null while no change version is open (nothing to edit yet). */
export function changeModeView(p: ChangePreview): ChangeModeView | null {
  if (!p.versionId || !p.contentHash) return null;
  return {
    changeRequestId: p.changeRequestId,
    refNo: p.refNo,
    kind: p.kind,
    changeSummary: p.changeSummary,
    requestItemIds: p.requestItemIds,
    changedItemIds: p.changedItemIds,
    itemNos: p.itemNos,
    contentHash: p.contentHash,
    canSubmit: p.canSubmit,
  };
}
