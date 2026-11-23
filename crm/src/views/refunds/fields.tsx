'use client';

import { useId, useState } from 'react';
import { Checkbox, ChoiceGroup, Radio } from '@/components/ui/choice';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { MoneyInput } from '@/components/ui/money-input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { maxRefundPaise } from '@/modules/refunds/limits';
import { OUTCOME_HINT, OUTCOME_WORD, PAYOUT_MODE_WORD, REFUND_KIND_WORD, rupees, rupeesToPaise, shortDay, SUPPLIER_REFUND_MODE_WORD } from './labels';
import type { PayeeKind, PayoutMode, RefundKind, RefundOutcome, SupplierRefundMode } from './types';

/*
 * Typed fields of the refund forms (contract 7.2, 7.3; Addendum L3 names).
 * Client parts only because fields appear and disappear with the choices
 * (outcome, payee, mode) and the maximum refund follows the typed charge
 * (track C's pure limits mirror; the database decides). Uncontrolled where
 * possible so a refusal keeps every typed value.
 */

const inr = (p: bigint) => rupees(p);

export interface RequestDefaults {
  useKeptCredit?: boolean;
  kind?: RefundKind;
  outcome?: RefundOutcome;
  customerChargePaise?: string;
  amountPaise?: string;
  payeeKind?: PayeeKind | null;
  payeeReceiptId?: string | null;
  payeeName?: string | null;
  payeeReason?: string | null;
  reason?: string;
}

const toRupees = (p?: string) => {
  if (!p) return '';
  const n = BigInt(p);
  const f = n % 100n;
  return f === 0n ? (n / 100n).toString() : `${n / 100n}.${f.toString().padStart(2, '0')}`;
};

/** C1 / C2 fields: kind, outcome, charge, amount, payee, reason. */
export function RefundRequestFields({
  heldPaise,
  basisTotalPaise,
  cancellationApproved,
  payers,
  defaults = {},
  keptCreditUnusedPaise,
  approvedChargePaise,
}: {
  /** Approved keep-as-credit not used yet: reserved unless this payout uses it (Addendum L7). */
  keptCreditUnusedPaise?: string;
  /** Highest approved settlement charge: a new request may not go below it (refusal charge_below_approved). */
  approvedChargePaise?: string | null;
  heldPaise: string;
  basisTotalPaise: string | null;
  cancellationApproved: boolean;
  payers: Array<{ receiptId: string; receiptNo: string; payerName: string; amountPaise: string }>;
  defaults?: RequestDefaults;
}) {
  const base = useId();
  const [kind, setKind] = useState<RefundKind>(defaults.kind ?? (cancellationApproved ? 'cancellation' : 'overpayment'));
  const [outcome, setOutcome] = useState<RefundOutcome>(defaults.outcome ?? 'payout');
  const [charge, setCharge] = useState(toRupees(defaults.customerChargePaise) || (kind === 'cancellation' ? '' : '0'));
  const [payee, setPayee] = useState<PayeeKind>(defaults.payeeKind ?? 'original_payer');
  const kept = BigInt(keptCreditUnusedPaise ?? '0');
  const [useKept, setUseKept] = useState(!!defaults.useKeptCredit);
  const chargePaise = kind === 'cancellation' ? (rupeesToPaise(charge || '0') ?? 0n) : 0n;
  const rawMax = maxRefundPaise({ kind, heldPaise: BigInt(heldPaise), chargePaise, basisTotalPaise: basisTotalPaise === null ? null : BigInt(basisTotalPaise) });
  // Kept credit stays reserved unless this payout uses it (the database decides; this is the screen's guide).
  const reserved = useKept && outcome === 'payout' ? 0n : kept;
  const max = rawMax > reserved ? rawMax - reserved : 0n;
  const outcomes: RefundOutcome[] = kind === 'cancellation' ? ['payout', 'keep_credit', 'charge_only'] : ['payout', 'keep_credit'];
  const effectiveOutcome = outcomes.includes(outcome) ? outcome : 'payout';

  return (
    <div className="flex flex-col gap-4">
      <ChoiceGroup id={`${base}-kind`} legend="What is this refund for?">
        {(['cancellation', 'overpayment'] as const).map((k) => (
          <Radio
            key={k}
            id={`${base}-kind-${k}`}
            name="kind"
            value={k}
            checked={kind === k}
            onChange={() => {
              setKind(k);
              if (k === 'overpayment') setCharge('0');
            }}
            disabled={k === 'cancellation' && !cancellationApproved}
            label={REFUND_KIND_WORD[k]}
            description={k === 'cancellation' ? (cancellationApproved ? 'The trip cancellation is approved.' : 'Not available: the trip cancellation is not approved yet.') : 'The customer paid more than the booking total.'}
          />
        ))}
      </ChoiceGroup>

      <ChoiceGroup id={`${base}-outcome`} legend="What should happen to the money?">
        {outcomes.map((o) => (
          <Radio key={o} id={`${base}-outcome-${o}`} name="outcome" value={o} checked={effectiveOutcome === o} onChange={() => setOutcome(o)} label={OUTCOME_WORD[o]} description={OUTCOME_HINT[o]} />
        ))}
      </ChoiceGroup>

      {kind === 'cancellation' ? (
        <Field
          htmlFor={`${base}-charge`}
          label="Customer cancellation charge (₹)"
          hint={`What we keep from the customer for the cancellation. The Manager approves this exact amount.${approvedChargePaise ? ` It cannot be lower than the charge already approved (${rupees(approvedChargePaise)}).` : ''}`}
        >
          <MoneyInput id={`${base}-charge`} name="customerChargeRupees" value={charge} onChange={(e) => setCharge(e.target.value)} required aria-describedby={`${base}-charge-hint`} />
        </Field>
      ) : (
        <input type="hidden" name="customerChargeRupees" value="0" />
      )}

      {effectiveOutcome === 'charge_only' ? (
        <input type="hidden" name="amountRupees" value="0" />
      ) : (
        <Field
          htmlFor={`${base}-amount`}
          label={effectiveOutcome === 'keep_credit' ? 'Amount kept as credit (₹)' : 'Amount to pay back (₹)'}
          hint={
            <>
              At most <strong className="tabular-nums">{inr(max)}</strong>
              {kind === 'cancellation' ? ' (verified money held minus the customer charge' : ' (verified money held minus the booking total'}
              {reserved > 0n ? ' and the credit kept earlier).' : ').'}
            </>
          }
        >
          <MoneyInput id={`${base}-amount`} name="amountRupees" defaultValue={toRupees(defaults.amountPaise)} required aria-describedby={`${base}-amount-hint`} />
        </Field>
      )}

      {effectiveOutcome === 'payout' && kept > 0n ? (
        <Checkbox
          id={`${base}-kept`}
          name="useKeptCredit"
          value="true"
          checked={useKept}
          onChange={(e) => setUseKept(e.target.checked)}
          label={`Pay this from the customer credit kept earlier (${rupees(kept)})`}
          description="Without this, the kept credit stays reserved for the customer and is not paid out."
        />
      ) : null}

      {effectiveOutcome === 'payout' ? (
        <ChoiceGroup id={`${base}-payee`} legend="Who gets the money?" hint="By default the person who paid. Anyone else needs a reason the Manager sees.">
          <Radio id={`${base}-payee-orig`} name="payeeKind" value="original_payer" checked={payee === 'original_payer'} onChange={() => setPayee('original_payer')} label="The person who paid" disabled={payers.length === 0} description={payers.length === 0 ? 'No verified payment to pay back to.' : undefined} />
          {payee === 'original_payer' && payers.length > 0 ? (
            <Field htmlFor={`${base}-payer`} label="Which payment" className="ml-6.5">
              <Select id={`${base}-payer`} name="payeeReceiptId" defaultValue={defaults.payeeReceiptId ?? payers[0]!.receiptId}>
                {payers.map((p) => (
                  <option key={p.receiptId} value={p.receiptId}>
                    {p.payerName} · {p.receiptNo} · {rupees(p.amountPaise)}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Radio id={`${base}-payee-other`} name="payeeKind" value="other" checked={payee === 'other'} onChange={() => setPayee('other')} label="Someone else" />
          {payee === 'other' ? (
            <div className="ml-6.5 flex flex-col gap-3">
              <Field htmlFor={`${base}-payee-name`} label="Name of the person to pay">
                <Input id={`${base}-payee-name`} name="payeeName" maxLength={200} required defaultValue={defaults.payeeName ?? ''} autoComplete="off" />
              </Field>
              <Field htmlFor={`${base}-payee-reason`} label="Why not the person who paid" hint="10 to 500 characters. The Manager sees this.">
                <Textarea id={`${base}-payee-reason`} name="payeeReason" rows={2} minLength={10} maxLength={500} required defaultValue={defaults.payeeReason ?? ''} aria-describedby={`${base}-payee-reason-hint`} />
              </Field>
            </div>
          ) : null}
        </ChoiceGroup>
      ) : null}

      <Field htmlFor={`${base}-reason`} label="Reason for the refund" hint="10 to 500 characters. The Manager and Accounts see this.">
        <Textarea id={`${base}-reason`} name="reason" rows={3} minLength={10} maxLength={500} required defaultValue={defaults.reason ?? ''} aria-describedby={`${base}-reason-hint`} />
      </Field>
    </div>
  );
}

/** C6 payout fields: mode, paid on, reference (blank only for cash), proof file. */
export function PayoutFields({ today, approvedOn }: { today: string; approvedOn: string | null }) {
  const base = useId();
  const [mode, setMode] = useState<PayoutMode>('bank_transfer');
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field htmlFor={`${base}-mode`} label="How it was paid">
          <Select id={`${base}-mode`} name="mode" value={mode} onChange={(e) => setMode(e.target.value as PayoutMode)}>
            {(Object.keys(PAYOUT_MODE_WORD) as PayoutMode[]).map((m) => (
              <option key={m} value={m}>
                {PAYOUT_MODE_WORD[m]}
              </option>
            ))}
          </Select>
        </Field>
        <Field htmlFor={`${base}-paid`} label="Paid on" hint={approvedOn ? `On or after the approval (${shortDay(approvedOn)}), not in the future.` : 'Not in the future.'}>
          <Input id={`${base}-paid`} type="date" name="paidOn" min={approvedOn ?? undefined} max={today} required aria-describedby={`${base}-paid-hint`} />
        </Field>
      </div>
      <Field htmlFor={`${base}-ref`} label={mode === 'cash' ? 'Reference' : 'Bank or UPI reference'} optional={mode === 'cash'} hint="4 to 40 letters, digits, / or -.">
        <Input id={`${base}-ref`} name="reference" maxLength={40} required={mode !== 'cash'} autoComplete="off" spellCheck={false} aria-describedby={`${base}-ref-hint`} />
      </Field>
      <Field htmlFor={`${base}-proof`} label="Payment proof" hint="PDF, JPG, PNG or WEBP, up to 4 MB. Stored privately; only Accounts and the approving Manager can open it.">
        <input id={`${base}-proof`} name="file" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" required aria-describedby={`${base}-proof-hint`} className="block w-full text-base" />
      </Field>
    </div>
  );
}

/** C7 supplier refund fields: amount, received on, mode, reference, over-expected reason, proof. */
export function SupplierRefundFields({ today, outstandingPaise }: { today: string; outstandingPaise: string }) {
  const base = useId();
  const [amount, setAmount] = useState('');
  const typed = rupeesToPaise(amount || '0') ?? 0n;
  const over = typed > BigInt(outstandingPaise);
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field htmlFor={`${base}-amount`} label="Amount received (₹)" hint={`Still expected: ${rupees(outstandingPaise)}.`}>
          <MoneyInput id={`${base}-amount`} name="amountRupees" value={amount} onChange={(e) => setAmount(e.target.value)} required aria-describedby={`${base}-amount-hint`} />
        </Field>
        <Field htmlFor={`${base}-on`} label="Received on">
          <Input id={`${base}-on`} type="date" name="receivedOn" max={today} required />
        </Field>
        <Field htmlFor={`${base}-mode`} label="How it came">
          <Select id={`${base}-mode`} name="mode" defaultValue="bank_transfer">
            {(Object.keys(SUPPLIER_REFUND_MODE_WORD) as SupplierRefundMode[]).map((m) => (
              <option key={m} value={m}>
                {SUPPLIER_REFUND_MODE_WORD[m]}
              </option>
            ))}
          </Select>
        </Field>
        <Field htmlFor={`${base}-ref`} label="Reference" hint="4 to 40 letters, digits, / or -.">
          <Input id={`${base}-ref`} name="reference" maxLength={40} required autoComplete="off" spellCheck={false} aria-describedby={`${base}-ref-hint`} />
        </Field>
      </div>
      {over ? (
        <Field htmlFor={`${base}-over`} label="Why it is more than expected" hint="10 to 500 characters. Needed because the amount is more than still expected.">
          <Textarea id={`${base}-over`} name="overExpectedReason" rows={2} minLength={10} maxLength={500} required aria-describedby={`${base}-over-hint`} />
        </Field>
      ) : null}
      <Field htmlFor={`${base}-proof`} label="Proof" hint="Bank statement line or supplier note. PDF, JPG, PNG or WEBP, up to 4 MB.">
        <input id={`${base}-proof`} name="file" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" required aria-describedby={`${base}-proof-hint`} className="block w-full text-base" />
      </Field>
      <p className="m-0 text-sm text-quiet">Recorded and verified in one step by you. It never changes what the customer owes.</p>
    </div>
  );
}
