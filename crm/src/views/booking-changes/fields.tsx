'use client';

import { useId, useState } from 'react';
import { Checkbox, ChoiceGroup, Radio } from '@/components/ui/choice';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { MoneyInput } from '@/components/ui/money-input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { DEPARTMENT_WORD } from './labels';
import { overBudgetHint, paiseText } from './rules';
import type { ChangeKind, ConfirmedServiceView, ProofOption, RemovableServiceView } from './types';

/*
 * Typed fields of the change forms (G2 / G3 / G7, Addendum L3 names: rupee
 * inputs `<key>Rupees`, the server converts to whole paise). Uncontrolled
 * where possible so a refusal keeps every typed value; client only for the
 * removal charge field that follows the picked service and the live
 * "above budget" hint on the reconfirmation amounts.
 */

export interface RequestDefaults {
  itemIds?: string[];
  changeSummary?: string;
  reason?: string;
  customerChargeRupees?: string;
}

const SUMMARY_HINT: Record<ChangeKind, string> = {
  change: 'What changes, in plain words (10 to 500 characters). Example: "Check-in moves from 12 to 13 Dec; one more room."',
  add_service: 'Which service to add and for when (10 to 500 characters). You add the details in the booking after the Manager approves.',
  remove_service: 'What is removed and what the customer was told (10 to 500 characters).',
};

/** G2 / G3 fields for one request kind. */
export function ChangeRequestFields({
  kind,
  confirmed,
  removable,
  addableTypes,
  defaults = {},
}: {
  kind: ChangeKind;
  confirmed: ConfirmedServiceView[];
  removable?: RemovableServiceView[];
  addableTypes?: string[];
  defaults?: RequestDefaults;
}) {
  const id = useId();
  const removeList: RemovableServiceView[] = removable ?? confirmed.map((c) => ({ itemId: c.itemId, itemNo: c.itemNo, serviceTitle: c.serviceTitle, department: c.department, booked: true }));
  const [picked, setPicked] = useState<string | null>(defaults.itemIds?.[0] ?? null);
  const pickedBooked = removeList.find((s) => s.itemId === picked)?.booked ?? false;
  return (
    <div className="flex flex-col gap-4">
      <input type="hidden" name="kind" value={kind} />
      {kind === 'change' ? (
        <ChoiceGroup id={`${id}-items`} legend="Which confirmed services change?" hint="Tick every service whose details will change (up to 20). A service you do not tick stays as it is.">
          {confirmed.map((c) => (
            <Checkbox
              key={c.itemId}
              id={`${id}-item-${c.itemId}`}
              name="itemIds"
              value={c.itemId}
              defaultChecked={defaults.itemIds?.includes(c.itemId)}
              label={`${c.itemNo}. ${c.serviceTitle}`}
              description={`${DEPARTMENT_WORD[c.department]}${c.supplierName ? ` · ${c.supplierName}` : ''}${c.reference ? ` · ref ${c.reference}` : ''}`}
            />
          ))}
        </ChoiceGroup>
      ) : null}
      {kind === 'remove_service' ? (
        <ChoiceGroup id={`${id}-remove`} legend="Which service is removed?" hint="One service per request.">
          {removeList.map((s) => (
            <Radio
              key={s.itemId}
              id={`${id}-rm-${s.itemId}`}
              name="itemIds"
              value={s.itemId}
              defaultChecked={defaults.itemIds?.[0] === s.itemId}
              onChange={() => setPicked(s.itemId)}
              label={`${s.itemNo}. ${s.serviceTitle}`}
              description={`${DEPARTMENT_WORD[s.department]} · ${s.booked ? 'booked with the supplier: supplier charges are entered before the Manager decides' : 'not booked yet: simple removal'}`}
            />
          ))}
        </ChoiceGroup>
      ) : null}
      {kind === 'remove_service' && pickedBooked ? (
        <Field htmlFor={`${id}-charge`} label="Charge to the customer for dropping it (₹)" hint="What the customer pays for removing this booked service. The Manager sees it before approving. Enter 0 if nothing is charged.">
          <MoneyInput id={`${id}-charge`} name="customerChargeRupees" required defaultValue={defaults.customerChargeRupees} aria-describedby={`${id}-charge-hint`} />
        </Field>
      ) : null}
      {kind === 'add_service' && addableTypes && addableTypes.length > 0 ? (
        <p className="m-0 text-sm text-quiet">Services that can be added: {addableTypes.join(', ')}.</p>
      ) : null}
      <Field htmlFor={`${id}-summary`} label={kind === 'add_service' ? 'What to add' : 'What changes'} hint={SUMMARY_HINT[kind]}>
        <Textarea id={`${id}-summary`} name="changeSummary" minLength={10} maxLength={500} required rows={3} defaultValue={defaults.changeSummary} aria-describedby={`${id}-summary-hint`} />
      </Field>
      <Field htmlFor={`${id}-reason`} label="Why" hint="The customer's reason or the supplier's (10 to 500 characters). The Manager reads it.">
        <Textarea id={`${id}-reason`} name="reason" minLength={10} maxLength={500} required rows={3} defaultValue={defaults.reason} aria-describedby={`${id}-reason-hint`} />
      </Field>
    </div>
  );
}

/** G7 fields: new rate, supplier fee, new reference, proof, note — with the live budget hint. */
export function ReconfirmFields({ budgetPaise, proofs, defaults = {} }: { budgetPaise: string | null; proofs: ProofOption[]; defaults?: { newRateRupees?: string; supplierFeeRupees?: string; newReference?: string; evidenceId?: string; note?: string } }) {
  const id = useId();
  const [rate, setRate] = useState(defaults.newRateRupees ?? '');
  const [fee, setFee] = useState(defaults.supplierFeeRupees ?? '');
  const hint = overBudgetHint(rate, fee, budgetPaise);
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field htmlFor={`${id}-rate`} label="Supplier's new rate (₹)" hint="The whole new price for this service.">
          <MoneyInput id={`${id}-rate`} name="newRateRupees" required value={rate} onChange={(e) => setRate(e.target.value)} aria-describedby={`${id}-rate-hint ${id}-budget`} />
        </Field>
        <Field htmlFor={`${id}-fee`} label="Supplier's change fee (₹)" hint="Enter 0 when the supplier charges no fee.">
          <MoneyInput id={`${id}-fee`} name="supplierFeeRupees" required value={fee} onChange={(e) => setFee(e.target.value)} aria-describedby={`${id}-fee-hint ${id}-budget`} />
        </Field>
      </div>
      <p id={`${id}-budget`} role="status" aria-live="polite" className="m-0 text-sm text-copy">
        {hint === null
          ? `Budget for this service: ${budgetPaise ? paiseText(BigInt(budgetPaise)) : 'none set'}.`
          : hint.over
            ? `New cost ${paiseText(hint.totalPaise)} is above the budget${budgetPaise ? ` of ${paiseText(BigInt(budgetPaise))}` : ''}. The branch Manager approves it before the change is applied.`
            : `New cost ${paiseText(hint.totalPaise)} is within the budget of ${paiseText(BigInt(budgetPaise!))}.`}
      </p>
      <Field htmlFor={`${id}-ref`} label="Supplier's new reference" hint="The confirmation number the supplier gave for the changed booking (up to 120 characters).">
        <Input id={`${id}-ref`} name="newReference" required maxLength={120} defaultValue={defaults.newReference} aria-describedby={`${id}-ref-hint`} />
      </Field>
      <Field htmlFor={`${id}-proof`} label="Supplier's confirmation (proof)" hint={proofs.length ? 'Pick the file you uploaded after the Manager approved the change.' : 'No confirmation file uploaded since the approval. Upload it under Supplier documents first.'}>
        <Select id={`${id}-proof`} name="evidenceId" required defaultValue={defaults.evidenceId ?? ''} aria-describedby={`${id}-proof-hint`}>
          <option value="" disabled>
            Choose a file
          </option>
          {proofs.map((p) => (
            <option key={p.evidenceId} value={p.evidenceId}>
              {p.fileName}
            </option>
          ))}
        </Select>
      </Field>
      <Field htmlFor={`${id}-note`} label="Note" optional hint="Anything Purchase should remember (up to 500 characters).">
        <Textarea id={`${id}-note`} name="note" maxLength={500} rows={2} defaultValue={defaults.note} aria-describedby={`${id}-note-hint`} />
      </Field>
    </div>
  );
}
