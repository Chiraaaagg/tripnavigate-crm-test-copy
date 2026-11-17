import { Building2, CircleCheck, CircleHelp, TriangleAlert } from 'lucide-react';
import { StatusBadge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Notice } from '@/components/ui/notice';
import { StateBlock } from '@/components/ui/state-block';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { CompanyPageModel } from '@/modules/settings/server/queries';
import { COMPANY_TEXT } from '@/modules/settings/text';

/*
 * Settings · Company and branches (DEC-50, DA-261). Read only: the company
 * details printed on quotations and itineraries (the reviewed code record)
 * and the branches with their GSTIN and the Bitrix pilot branch. No form, no
 * switch; company data only (no customer, deal or price data). A missing
 * GSTIN says what it blocks; a pilot that could not be read says so, never
 * "No". Look: corr Key Value List 25162 (SummaryList) and the originui dense
 * table (Table 89), as recorded in the 21st register.
 *
 * R1: the area heading and line come from the Settings frame; the page opens
 * with one read-only line (StateBlock readOnly, C8) saying who changes it.
 */

/** The read-only line (R1): who can change these details. */
export const COMPANY_READ_ONLY_LINE = 'The CRM team changes them, using the details Accounts approved and the owner’s yes.';

export function CompanyBranchesView({ model }: { model: CompanyPageModel }) {
  return (
    <>
      <StateBlock kind="readOnly" text="You can view these details." who={COMPANY_READ_ONLY_LINE} />
      <Card>
        <section aria-labelledby="company-details-heading">
          <CardHeader>
            <CardTitle id="company-details-heading" level={2}>
              <span className="inline-flex items-center gap-2">
                <Building2 aria-hidden="true" className="size-4.5 text-faint" />
                Company details
              </span>
            </CardTitle>
          </CardHeader>
          <CardBody>
            <SummaryList>
              {model.company.map((row) => (
                <SummaryRow key={row.label} label={row.label}>
                  <span className="wrap-break-word">{row.value}</span>
                </SummaryRow>
              ))}
            </SummaryList>
          </CardBody>
        </section>
      </Card>
      <section aria-labelledby="branches-heading" className="flex flex-col gap-3">
        <h2 id="branches-heading" className="m-0 text-lg font-semibold text-ink">
          Branches
        </h2>
        <Table label="Branches" stackOnMobile>
          <TableCaption className="sr-only">Branches, their GSTIN and the Bitrix pilot branch</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{COMPANY_TEXT.branch}</TableHead>
              <TableHead scope="col">{COMPANY_TEXT.state}</TableHead>
              <TableHead scope="col">{COMPANY_TEXT.gstin}</TableHead>
              <TableHead scope="col">{COMPANY_TEXT.pilot}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {model.branches.map((b) => (
              <TableRow key={b.name}>
                <TableCell className="font-semibold text-ink">{b.name}</TableCell>
                <TableCell label={COMPANY_TEXT.state}>{b.state}</TableCell>
                <TableCell label={COMPANY_TEXT.gstin}>
                  {b.gstin ? (
                    <span className="font-mono tabular-nums">{b.gstin}</span>
                  ) : (
                    <span className="inline-flex items-start gap-1.5 text-copy">
                      <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-warning" />
                      <span>{b.gstinText}</span>
                    </span>
                  )}
                </TableCell>
                <TableCell label={COMPANY_TEXT.pilot}>
                  {b.pilot === 'yes' ? (
                    <StatusBadge tone="brand" icon={CircleCheck}>
                      {b.pilotText}
                    </StatusBadge>
                  ) : b.pilot === 'unknown' ? (
                    <span className="inline-flex items-start gap-1.5 text-copy">
                      <CircleHelp aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-warning" />
                      <span>{b.pilotText}</span>
                    </span>
                  ) : (
                    <span>
                      <span aria-hidden="true">{b.pilotText}</span>
                      <span className="sr-only">Not the pilot branch</span>
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {model.notApproved.length > 0 ? (
          <Notice tone="warning" title="Branches not in the approved company details">
            {model.notApproved.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </Notice>
        ) : null}
      </section>
    </>
  );
}

/** The page could not be built (the branch read failed): honest, nothing assumed. */
export function CompanyBranchesErrorView() {
  return (
    <Notice tone="danger" role="alert">
      <p>{COMPANY_TEXT.loadFailed}</p>
    </Notice>
  );
}

/** A person with no Settings right (the route's own check). */
export function CompanyBranchesNoPermissionView() {
  return (
    <Notice tone="restricted" role="status">
      <p>{COMPANY_TEXT.noPermission}</p>
    </Notice>
  );
}
