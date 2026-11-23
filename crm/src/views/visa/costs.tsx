import { FileText } from 'lucide-react';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { inr } from './format';
import { COST_KIND_LABEL, EXPENSE_STATUS_LABEL, PAID_BY_LABEL, plural } from './labels';
import type { VisaApplicationState, VisaWorkspace } from './types';
import { otherCostsOf } from './work-model';

/*
 * Visa costs per traveller (contract 11.1, V9: the HTML "Visa lines for the
 * invoice" H:15035 retitled and read from the real cost entries). Costs only,
 * never the customer's price. Task-level fees recorded before per-passenger
 * fees are listed below. Visa desk and branch Manager only.
 */

const RESULT: Record<VisaApplicationState, string> = {
  docs_pending: 'Not applied',
  submitted: 'Applied',
  decision_pending: 'Applied',
  issued: 'Approved',
  refused: 'Rejected',
  withdrawn: 'Withdrawn',
};

export function VisaCostsCard({ ws }: { ws: VisaWorkspace }) {
  const cs = ws.costSummary;
  if (!cs) return null;
  const others = cs.travellers.some((t) => otherCostsOf(t));
  const passport = ws.serviceType === 'passport';
  const kind = 'visa' in ws.facts ? `${ws.facts.visa.country} · ${ws.facts.visa.purpose}` : 'Passport';
  const title = passport ? 'Passport costs per applicant' : 'Visa costs per traveller';
  /** Accounts status per fee kind from the passenger's own entries (a returned fee can sit next to an accepted one). */
  const statusOf = (t: (typeof cs.travellers)[number]): string => {
    const fees = ws.applicants.find((a) => a.seq === t.seq)?.fees ?? [];
    const lines = fees
      .filter((f) => f.paidBy === 'company' && f.expenseStatus)
      .map((f) => `${COST_KIND_LABEL[f.costKind]}: ${EXPENSE_STATUS_LABEL[f.expenseStatus!]}`);
    if (lines.length) return lines.join(' · ');
    return t.expenseStatus ? EXPENSE_STATUS_LABEL[t.expenseStatus] : t.paidBy === 'customer_direct' ? 'Recorded only' : '—';
  };
  return (
    <Card>
      <section aria-labelledby={`visa-costs-${ws.taskId}`}>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id={`visa-costs-${ws.taskId}`}>{title}</CardTitle>
            <CardDescription>Fees recorded per {passport ? 'applicant' : 'traveller'} for Accounts. These are costs, not the customer’s price.</CardDescription>
          </div>
          <FileText aria-hidden="true" className="size-4 text-faint" />
        </CardHeader>
        {cs.travellers.length === 0 ? (
          <CardBody>
            <p className="m-0 text-quiet">No fees recorded yet. Fees are recorded when a passenger is marked applied.</p>
          </CardBody>
        ) : (
          <Table label={`${title} table`} stackOnMobile wrapperClassName="rounded-b-card">
            <TableCaption className="caption-top border-b border-line py-3 text-left font-medium text-copy max-sm:block">
              {plural(cs.travellers.length, passport ? 'applicant' : 'traveller')} · Company paid {inr(cs.companyTotalPaise, '₹0.00')} · Customer paid directly {inr(cs.customerDirectTotalPaise, '₹0.00')}
            </TableCaption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{passport ? 'Applicant' : 'Traveller'}</TableHead>
                <TableHead>{passport ? 'Service' : 'Visa'}</TableHead>
                <TableHead numeric>Government fee</TableHead>
                <TableHead numeric>Service fee</TableHead>
                {others ? <TableHead numeric>Other costs</TableHead> : null}
                <TableHead>Paid by</TableHead>
                <TableHead>Accounts status</TableHead>
                <TableHead>Result</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cs.travellers.map((t) => (
                <TableRow key={t.seq}>
                  <TableCell>
                    <span className="font-semibold wrap-anywhere text-ink">{t.name ?? `Traveller ${t.seq}`}</span>
                  </TableCell>
                  <TableCell label={passport ? 'Service' : 'Visa'} className="text-sm">
                    {kind}
                  </TableCell>
                  <TableCell label="Government fee" numeric>
                    {inr(t.governmentFeePaise)}
                  </TableCell>
                  <TableCell label="Service fee" numeric>
                    {inr(t.serviceFeePaise)}
                  </TableCell>
                  {others ? (
                    <TableCell label="Other costs" numeric>
                      {inr(otherCostsOf(t))}
                    </TableCell>
                  ) : null}
                  <TableCell label="Paid by">{t.paidBy ? PAID_BY_LABEL[t.paidBy] : '—'}</TableCell>
                  <TableCell label="Accounts status">{statusOf(t)}</TableCell>
                  <TableCell label="Result">{t.state ? RESULT[t.state] : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {cs.taskLevel.length > 0 ? (
          <CardBody className="border-t border-line">
            <h3 className="m-0 mb-2 text-base font-semibold text-ink">Task-level fees (recorded before per-passenger fees)</h3>
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
              {cs.taskLevel.map((f) => (
                <li key={f.entryId} className="m-0">
                  {f.costKind === 'fare' ? 'Fare' : COST_KIND_LABEL[f.costKind]} · {inr(f.amountPaise)} · {PAID_BY_LABEL[f.paidBy]}
                  {f.expenseStatus ? ` · ${EXPENSE_STATUS_LABEL[f.expenseStatus]}` : ''}
                </li>
              ))}
            </ul>
          </CardBody>
        ) : null}
      </section>
    </Card>
  );
}
