'use client';

import { useState } from 'react';
import { ApprovalRowActions } from '@/components/ui/approval-row-actions';
import { Collapsible } from '@/components/ui/collapsible';
import { ConfirmChange, type ConfirmResult } from '@/components/ui/confirm-change';
import { RecordHeader } from '@/components/ui/record-header';
import { Status } from '@/components/ui/status';
import { SwitchRow, switchRowDescribedBy } from '@/components/ui/switch-row';

/*
 * Client demos for the redesign parts gallery. The change actions here run
 * in the browser and change nothing: a reason containing the word "refuse"
 * is refused (to show the refusal state), anything else is "saved".
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function demoChange(_prev: ConfirmResult | null, formData: FormData): Promise<ConfirmResult> {
  await wait(150);
  const reason = String(formData.get('reason') ?? '');
  if (/refuse/i.test(reason)) return { ok: false, message: 'Sample refusal: the change was not saved (gallery only).', fields: [] };
  const key = String(formData.get('key') ?? 'the switch');
  return { ok: true, message: `Saved (gallery only): ${key} changed${reason.trim() ? ' with your reason' : ' with no reason given'}.` };
}

async function demoReturn(_prev: ConfirmResult | null, formData: FormData): Promise<ConfirmResult> {
  await wait(150);
  const reason = String(formData.get('return_reason') ?? '');
  if (/refuse/i.test(reason)) return { ok: false, message: 'Sample refusal: someone else decided this row first (gallery only).', fields: ['return_reason'] };
  return { ok: true, message: 'Returned (gallery only). Purchase sees your reason.' };
}

async function demoApprove(): Promise<void> {
  await wait(150);
}

export function SwitchRowsDemo() {
  return (
    <div className="rounded-card border border-line bg-card shadow-card">
      <SwitchRow
        id="g-sw-goahead"
        name="Hotel go-ahead"
        effect="Purchase books a hotel only after Accounts gives the go-ahead."
        more={<p className="m-0">Applies to every branch. Company-funded hotels also need the go-ahead. Switching it off lets Purchase book without waiting.</p>}
        state="on"
        last={{ who: 'Sample Admin A', when: '6 Nov 2026, 10:15' }}
        change={
          <ConfirmChange
            title="Switch Hotel go-ahead off?"
            effect="Purchase can book hotels without waiting for Accounts."
            affected="Accounts and every Purchase person (sample)."
            confirmLabel="Switch off"
            tone="danger"
            reason="optional"
            formAction={demoChange}
            hiddenFields={{ key: 'hotel_go_ahead', state: 'off', confirm: 'yes' }}
            trigger={{ label: 'Change', describedBy: switchRowDescribedBy('g-sw-goahead') }}
          />
        }
      />
      <SwitchRow
        id="g-sw-visa"
        name="Visa and passport tasks"
        effect="Creates a task for the Visa desk when a booking has a visa service."
        state="off"
        last={null}
        change={
          <ConfirmChange
            title="Switch Visa and passport tasks on?"
            effect="New bookings with a visa service create a Visa desk task."
            confirmLabel="Switch on"
            reason="required"
            reasonHint="Finance and booking switches keep a required reason: 10 to 500 characters."
            formAction={demoChange}
            hiddenFields={{ key: 'visa_passport_tasks_enabled', state: 'on', confirm: 'yes' }}
            trigger={{ label: 'Change', describedBy: switchRowDescribedBy('g-sw-visa') }}
          />
        }
      />
      <SwitchRow id="g-sw-unknown" name="Booking messages" effect="Sends the nine approved booking messages to customers." state="unknown" />
      <SwitchRow
        id="g-sw-blocked"
        name="Bitrix sync scope"
        effect="Which Bitrix pipelines the CRM reads."
        state="on"
        last={{ who: 'Sample Admin B', when: '2 Nov 2026, 18:40' }}
        disabledReason="Only a Super Admin can change this."
      />
    </div>
  );
}

export function ConfirmDemos() {
  return (
    <div className="flex flex-wrap items-start gap-4">
      <ConfirmChange
        title="Mark the itinerary as shared?"
        effect="The Deal shows the itinerary as shared with the customer today."
        confirmLabel="Mark as shared"
        reason="none"
        formAction={demoChange}
        hiddenFields={{ key: 'itinerary_shared' }}
        trigger={{ label: 'Open confirm (no reason)' }}
      />
      <ConfirmChange
        title="Switch Staff notices on?"
        effect="Staff get a notice in the bell when work arrives for them."
        affected="Every staff member (sample)."
        confirmLabel="Switch on"
        reason="optional"
        formAction={demoChange}
        hiddenFields={{ key: 'staff_notices', state: 'on', confirm: 'yes' }}
        trigger={{ label: 'Open confirm (optional reason)' }}
      />
      <ConfirmChange
        title="Return payment request SAMPLE-P-102?"
        effect="The request goes back to Purchase with your reason. Nothing is paid."
        confirmLabel="Return"
        tone="danger"
        reason="required"
        reasonName="return_reason"
        formAction={demoReturn}
        hiddenFields={{ request_id: 'sample-p-102' }}
        trigger={{ label: 'Open confirm (required reason)' }}
      />
    </div>
  );
}

export function ApprovalRowsDemo() {
  return (
    <ul className="m-0 flex list-none flex-col divide-y divide-line rounded-card border border-line bg-card p-0 shadow-card">
      <li className="m-0 flex flex-col gap-3 px-4.5 py-3.5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="m-0 font-semibold text-ink">SAMPLE-P-102 · Sample Hotel A</p>
          <p className="m-0 text-sm text-quiet">₹62,000.00 · raised by Sample Purchase A</p>
          <Status kind="waiting_for_manager" className="mt-1.5" />
        </div>
        <ApprovalRowActions
          recordName="SAMPLE-P-102"
          approve={{ formAction: demoApprove, hiddenFields: { request_id: 'sample-p-102', decision: 'approve' } }}
          returnChange={{
            formAction: demoReturn,
            title: 'Return payment request SAMPLE-P-102?',
            effect: 'The request goes back to Purchase with your reason. Nothing is paid.',
            reasonName: 'return_reason',
            hiddenFields: { request_id: 'sample-p-102', decision: 'return' },
          }}
        />
      </li>
      <li className="m-0 flex flex-col gap-3 px-4.5 py-3.5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="m-0 font-semibold text-ink">SAMPLE-P-103 · Sample Hotel B</p>
          <p className="m-0 text-sm text-quiet">₹18,500.00 · raised by you (sample)</p>
          <Status kind="requested" className="mt-1.5" />
        </div>
        <ApprovalRowActions
          recordName="SAMPLE-P-103"
          approve={{ formAction: demoApprove }}
          returnChange={{ formAction: demoReturn, title: 'Return SAMPLE-P-103?', effect: 'Back to Purchase.' }}
          disabledReason="You raised this, so a different person approves it."
        />
      </li>
    </ul>
  );
}

export function RecordHeaderFormDemo() {
  return (
    <RecordHeader
      back={{ href: '/preview/ui-gallery/redesign', label: 'Purchase tasks' }}
      recordId="SAMPLE-PT-31"
      title="Hotel for SAMPLE — Udaipur weekend"
      status={<Status kind="not_taken" />}
      next={{ text: 'Take this task so it is yours.', button: { label: 'Take task', formAction: demoApprove, hiddenFields: { task_id: 'sample-pt-31' } } }}
    />
  );
}

export function CollapsibleDemo() {
  const [salesOpen, setSalesOpen] = useState(true);
  return (
    <nav aria-label="Sample menu groups" className="flex w-64 max-w-full flex-col gap-2 rounded-card border border-line bg-card p-2 shadow-card">
      <Collapsible open={salesOpen} onOpenChange={setSalesOpen} trigger="Sales">
        <ul className="m-0 flex list-none flex-col p-0">
          {['Leads', 'Deals', 'Quotations'].map((l) => (
            <li key={l} className="m-0 px-2.5 py-1.5 text-sm text-copy">
              {l}
            </li>
          ))}
        </ul>
      </Collapsible>
      <Collapsible defaultOpen={false} trigger="Desks" meta={<span className="rounded-full bg-wash px-1.5 text-xs leading-5 font-semibold text-ink tabular-nums">5</span>}>
        <ul className="m-0 flex list-none flex-col p-0">
          {['Purchase tasks', 'Flight tasks', 'Suppliers'].map((l) => (
            <li key={l} className="m-0 px-2.5 py-1.5 text-sm text-copy">
              {l}
            </li>
          ))}
        </ul>
      </Collapsible>
    </nav>
  );
}
