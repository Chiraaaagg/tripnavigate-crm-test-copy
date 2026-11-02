import { BadgeCheck, Building2, CircleHelp, Landmark } from 'lucide-react';
import Link from 'next/link';
import type React from 'react';
import { StatusBadge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  BENEFICIARY_NOTICE,
  BENEFICIARY_STATUS_LABEL,
  SERVICE_TYPE_LABEL,
  type SupplierDetailView,
  type SupplierSummary,
  VERIFICATION_LABEL,
} from '@/modules/procurement/contracts';
import { HOLD_REASON_TEXT } from '@/modules/supplier-money/contracts';
import { TaskBackLink } from './department/task-frame';
import { AddBeneficiaryForm, ApproveBeneficiaryForm, CreateSupplierForm, EditSupplierForm, VerifySupplierForm } from './procurement-forms';
import { formatIst } from './staff-views';
import { OrNotRecorded } from './value-states';

/*
 * Purchase supplier screens (Phase 4; the task Work tab moved to
 * views/purchase/work-tab.tsx in the Purchase build, 2 Nov 2026). Bank
 * details as masked rows (21st.dev "Payment Methods Checkbox" 24933). When
 * the latest bank details are not approved, supplier payments are on hold
 * (Purchase build, Track B rule) and the page says so.
 */

const metaClass = 'm-0 text-sm text-quiet';

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

function VerificationPill({ status }: { status: SupplierSummary['verificationStatus'] }) {
  return (
    <StatusBadge tone={status === 'verified' ? 'success' : 'warning'} icon={status === 'verified' ? BadgeCheck : CircleHelp} wrap>
      <span className="sr-only">Verification: </span>
      {VERIFICATION_LABEL[status]}
    </StatusBadge>
  );
}

function SectionCard({ id, title, children, description }: { id: string; title: string; children: React.ReactNode; description?: React.ReactNode }) {
  return (
    <Card className="mt-5">
      <section aria-labelledby={id}>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id={id}>{title}</CardTitle>
            {description ? <CardDescription>{description}</CardDescription> : null}
          </div>
        </CardHeader>
        <CardBody>{children}</CardBody>
      </section>
    </Card>
  );
}

/** PU-03 Suppliers (Direction A list look; forms unchanged). */
export function SupplierListPage({ suppliers, entities }: { suppliers: SupplierSummary[]; entities: Array<{ id: string; name: string }> }) {
  const canAdd = entities.length > 0;
  return (
    <div className="font-sans text-base text-copy">
      <TaskBackLink href="/app/purchase">Back to Purchase tasks</TaskBackLink>
      <PageHeader eyebrow="Purchase" title="Suppliers" description="Supplier details are recorded by Purchase and stay marked “not verified” until a manager verifies them; any later change by Purchase marks them not verified again." />
      <Card>
        {suppliers.length === 0 ? (
          <EmptyState icon={Building2} headingLevel={2} title="No suppliers yet" description={canAdd ? 'Add the first supplier below.' : 'Purchase colleagues add suppliers here.'} />
        ) : (
          <Table stackOnMobile label="Suppliers table" wrapperClassName="rounded-card">
            <TableCaption className="caption-top border-b border-line py-3 font-medium text-copy max-sm:block">
              {suppliers.length} {suppliers.length === 1 ? 'supplier' : 'suppliers'}
            </TableCaption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Supplier</TableHead>
                <TableHead>Services</TableHead>
                <TableHead>City</TableHead>
                <TableHead>Details</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {suppliers.map((s) => (
                <TableRow key={s.supplierId} className="align-top">
                  <TableCell label="Supplier" className="align-top">
                    <Link href={`/app/purchase/suppliers/${s.supplierId}`} className={cn('rounded-chip font-semibold text-brand-strong underline-offset-4 hover:text-brand-deep hover:underline', focusRing)}>
                      {s.name}
                    </Link>
                  </TableCell>
                  <TableCell label="Services" className="align-top">
                    {s.serviceTypes.map((t) => SERVICE_TYPE_LABEL[t]).join(', ')}
                  </TableCell>
                  <TableCell label="City" className="align-top">
                    <OrNotRecorded value={s.city} />
                  </TableCell>
                  <TableCell label="Details" className="align-top">
                    <VerificationPill status={s.verificationStatus} />
                  </TableCell>
                  <TableCell label="Status" className="align-top">
                    {s.status === 'active' ? 'Active' : 'Archived'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
      {canAdd ? (
        <SectionCard id="supplier-add" title="Add a supplier">
          <CreateSupplierForm entities={entities} />
        </SectionCard>
      ) : null}
    </div>
  );
}

/** PU-04 Supplier record (Direction A frame; forms unchanged). */
export function SupplierDetailPage({ supplier, justCreated }: { supplier: SupplierDetailView; justCreated?: boolean }) {
  return (
    <div className="font-sans text-base text-copy">
      <TaskBackLink href="/app/purchase/suppliers">Back to suppliers</TaskBackLink>
      <PageHeader
        eyebrow="Supplier"
        title={<span className="block wrap-anywhere">{supplier.name}</span>}
        status={
          <>
            <VerificationPill status={supplier.verificationStatus} />
            {supplier.verificationStatus === 'verified' && supplier.verifiedAt ? (
              <span className="text-copy">
                Verified{supplier.verifiedByName ? ` by ${supplier.verifiedByName}` : ''} · {formatIst(supplier.verifiedAt)}. A change of details by Purchase marks it not verified again.
              </span>
            ) : null}
          </>
        }
        actions={supplier.canVerify ? <VerifySupplierForm supplierId={supplier.supplierId} rowVersion={supplier.rowVersion} /> : undefined}
      />
      {justCreated ? (
        <Notice tone="success" role="status">
          <strong>Done: </strong>Supplier added. Details are marked not verified.
        </Notice>
      ) : null}
      <SectionCard id="supplier-edit" title="Details" description={`Last changed ${formatIst(supplier.updatedAt)}.`}>
        {supplier.canEdit ? <EditSupplierForm supplier={supplier} /> : <SupplierFacts supplier={supplier} />}
      </SectionCard>
      <SectionCard id="supplier-bank" title="Bank details">
        <div className="flex flex-col gap-4">
          {supplier.beneficiaries[0] && supplier.beneficiaries[0].status !== 'approved' ? (
            <Notice tone="warning" title="Payments to this supplier are on hold">
              <p>{HOLD_REASON_TEXT.bank_details_on_hold}</p>
            </Notice>
          ) : null}
          <Notice tone="info">{BENEFICIARY_NOTICE}</Notice>
          {supplier.beneficiaries.length === 0 ? (
            <p className="m-0 text-quiet">No bank details recorded.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-3 p-0" aria-label="Bank detail revisions, newest first">
              {supplier.beneficiaries.map((b) => (
                <li key={b.revisionNo} className="m-0 flex gap-3 rounded-control border border-line bg-canvas px-3.5 py-3">
                  <Landmark aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-faint" />
                  <div className="min-w-0 flex-1">
                    <p className="m-0 text-ink">
                      <strong>Revision {b.revisionNo}</strong>
                      {b.revisionNo === supplier.beneficiaries[0]!.revisionNo ? ' · latest' : ' · earlier'} · {BENEFICIARY_STATUS_LABEL[b.status]}
                    </p>
                    <p className="m-0 wrap-anywhere">
                      {b.accountHolder} · {b.bankName} · {b.ifsc} ·{' '}
                      <span className="whitespace-nowrap tabular-nums">
                        <span aria-hidden="true">•••• </span>
                        <span className="sr-only">account ending </span>
                        {b.accountLast4}
                      </span>
                    </p>
                    <p className={metaClass}>
                      Recorded {formatIst(b.createdAt)}
                      {b.createdByName ? ` by ${b.createdByName}` : ''}
                      {b.approvedAt ? ` · approved ${formatIst(b.approvedAt)}${b.approvedByName ? ` by ${b.approvedByName}` : ''}` : ''}
                    </p>
                    {b.canApprove ? <ApproveBeneficiaryForm supplierId={supplier.supplierId} revisionNo={b.revisionNo} /> : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {supplier.canEdit ? (
            <details className="form-section work-form">
              <summary>
                <span className="form-section-title">Record new bank details</span>
              </summary>
              <AddBeneficiaryForm supplierId={supplier.supplierId} />
            </details>
          ) : null}
        </div>
      </SectionCard>
    </div>
  );
}

/** Read-only supplier details for managers (they verify; Purchase edits). */
function SupplierFacts({ supplier }: { supplier: SupplierDetailView }) {
  return (
    <dl className="facts m-0">
      <dt>Services</dt>
      <dd>{supplier.serviceTypes.map((t) => SERVICE_TYPE_LABEL[t]).join(', ')}</dd>
      <dt>City</dt>
      <dd>
        <OrNotRecorded value={supplier.city} />
      </dd>
      <dt>Contact person</dt>
      <dd>
        <OrNotRecorded value={supplier.contactName} />
      </dd>
      <dt>Phone</dt>
      <dd>
        <OrNotRecorded value={supplier.contactPhone} />
      </dd>
      <dt>Email</dt>
      <dd>
        <OrNotRecorded value={supplier.contactEmail} />
      </dd>
      <dt>Payment terms</dt>
      <dd className="prewrap">
        <OrNotRecorded value={supplier.paymentTerms} />
      </dd>
      <dt>Status</dt>
      <dd>{supplier.status === 'active' ? 'Active' : 'Archived'}</dd>
    </dl>
  );
}

export function SupplierNotFoundView() {
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader title="Supplier not available" />
      <Notice tone="locked" role="status">
        We couldn’t find this supplier, or you may not have access.
      </Notice>
      <p className="m-0 mt-4">
        <Link href="/app/purchase/suppliers" className={buttonVariants({ variant: 'secondary' })}>
          Back to suppliers
        </Link>
      </p>
    </div>
  );
}
