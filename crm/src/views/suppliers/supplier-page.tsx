import { Hotel, Mail, Phone, Star } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { StatusBadge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs } from '@/components/ui/tabs';
import { UnavailableAction } from '@/views/accounts/supplier-forms';
import type { DeskResult } from '@/views/accounts-desk/desk-kit';
import { formatIst } from '@/views/deal-labels';
import { TaskBackLink } from '@/views/department/task-frame';
import { ContactDialog, ContactIcon, DuplicateWarnings, LinkHotelDialog, RemoveContactDialog, SupplierDetailsForm, UnlinkHotelDialog, type SupplierFormActions } from './forms';
import { CHANGE_SOURCE_WORD, fieldWord, HOTEL_SOURCE_WORD, KIND_LABEL, SERVICE_LABEL, stateText, historyValueWord } from './labels';
import { SupplierStatusBadges } from './register';
import type { CatalogueHotelSearch, SupplierMaster, SupplierServiceType, SupplierViewer } from './types';

/*
 * Supplier page (Accounts phase 2 contract 5.7 R-A2, 11.9): status, next step
 * and the one primary action (Verify, for a Manager) at the top; possible
 * duplicates as a warning (never a block); link tabs Details, Contacts,
 * Hotels sold, History (each a ?tab= address, so they work without script).
 * Bank details keep the existing section (passed in by the route), so bank
 * approval and payment holds are unchanged. History never shows bank
 * numbers; PAN is masked unless the reader is Accounts or a Manager.
 */

export type SupplierTab = 'details' | 'contacts' | 'hotels' | 'history';
export const SUPPLIER_TABS: readonly SupplierTab[] = ['details', 'contacts', 'hotels', 'history'];

export interface SupplierPagePreview {
  editState?: DeskResult | null;
  contactOpen?: boolean;
  contactState?: DeskResult | null;
  removeContactOpen?: boolean;
  linkOpen?: boolean;
  linkState?: DeskResult | null;
}

function nextStep(s: SupplierMaster): string {
  if (s.verification === 'unverified') return 'Next: a Manager checks and verifies these details.';
  if (s.bankState === 'on_hold') return 'Next: a Manager who did not record them approves the latest bank details. Payments wait until then.';
  if (s.bankState === 'none') return 'Next: record bank details before any payment to this supplier.';
  return 'Ready to use for rates and payments.';
}

export function SupplierMasterPage({
  supplier: s,
  tab,
  viewer,
  basePath = '/app/purchase/suppliers',
  back,
  states,
  actions,
  searchHotels,
  verifyAction,
  bank,
  justCreated,
  preview,
}: {
  supplier: SupplierMaster;
  tab: SupplierTab;
  viewer: SupplierViewer;
  basePath?: string;
  back?: { href: string; label: string };
  states: ReadonlyArray<{ code: string; name: string }>;
  /** Editors only (Purchase for non-flight suppliers, Flight for flight suppliers); null = read only. */
  actions?: SupplierFormActions | null;
  searchHotels?: CatalogueHotelSearch | null;
  /** The existing Verify form (Manager); shown when can.verify. */
  verifyAction?: ReactNode;
  /** The existing bank details section (revisions, approve, record new). */
  bank?: ReactNode;
  justCreated?: boolean;
  preview?: SupplierPagePreview;
}) {
  const href = (t: SupplierTab) => `${basePath}/${s.supplierId}${t === 'details' ? '' : `?tab=${t}`}`;
  const sellsHotels = s.serviceTypes.includes('hotel');
  const activeContacts = s.contacts.filter((c) => c.status === 'active');
  const canEdit = s.can.edit && !!actions;
  const serviceChoices: SupplierServiceType[] = s.serviceTypes.includes('flight') ? ['flight'] : ['hotel', 'transfer', 'activity'];
  const backLink = back ?? (viewer === 'flight' ? { href: '/app/flight', label: 'Back to Flight tasks' } : { href: basePath, label: 'Back to suppliers' });
  return (
    <div className="flex flex-col gap-5 font-sans text-base text-copy">
      <div>
        <TaskBackLink href={backLink.href}>{backLink.label}</TaskBackLink>
        <PageHeader
          className="mb-[0]"
          eyebrow={`Supplier · ${KIND_LABEL[s.kind]}`}
          title={<span className="block wrap-anywhere">{s.name}</span>}
          status={
            <>
              <SupplierStatusBadges row={s} />
              {s.status === 'archived' ? <span className="text-copy">Archived</span> : null}
              <span className="basis-full text-copy">
                {s.verification === 'verified' && s.verifiedAt ? `Verified${s.verifiedByName ? ` by ${s.verifiedByName}` : ''} · ${formatIst(s.verifiedAt)}. ` : ''}
                {nextStep(s)}
              </span>
            </>
          }
          actions={s.can.verify ? verifyAction : undefined}
        />
      </div>
      {justCreated ? (
        <Notice tone="success" role="status">
          <p>
            <strong>Done: </strong>Supplier added. Its details are marked “Not verified”.
          </p>
        </Notice>
      ) : null}
      <DuplicateWarnings items={s.duplicates} title="Possible duplicate supplier" />

      <Tabs
        label="Supplier sections"
        items={[
          { href: href('details'), label: 'Details', current: tab === 'details' },
          { href: href('contacts'), label: 'Contacts', current: tab === 'contacts', count: activeContacts.length },
          ...(sellsHotels ? [{ href: href('hotels'), label: 'Hotels sold', current: tab === 'hotels', count: s.hotels.length }] : []),
          { href: href('history'), label: 'History', current: tab === 'history' },
        ]}
      />

      {tab === 'details' || (tab === 'hotels' && !sellsHotels) ? (
        <>
          <Card>
            <section aria-labelledby="sup-details">
              <CardHeader>
                <div className="min-w-0">
                  <CardTitle id="sup-details">Details</CardTitle>
                  {canEdit ? <CardDescription>Change and save. A change of name, kind, GSTIN, PAN or state needs a Manager’s check again.</CardDescription> : null}
                </div>
              </CardHeader>
              <CardBody>
                {canEdit && actions?.update ? (
                  <SupplierDetailsForm mode="edit" action={actions.update} supplier={s} states={states} serviceChoices={serviceChoices} initialState={preview?.editState} />
                ) : (
                  <SupplierFacts s={s} states={states} showLedger={viewer === 'manager' || viewer === 'accounts'} />
                )}
              </CardBody>
            </section>
          </Card>
          {bank ?? <BankSummary s={s} />}
        </>
      ) : null}

      {tab === 'contacts' ? (
        <Card>
          <section aria-labelledby="sup-contacts">
            <CardHeader className="max-sm:flex-col max-sm:items-start">
              <div className="min-w-0">
                <CardTitle id="sup-contacts">Contacts</CardTitle>
                <CardDescription>The primary contact gets rate requests and booking e-mails.</CardDescription>
              </div>
              {canEdit && actions?.saveContact ? (
                <ContactDialog supplierId={s.supplierId} action={actions.saveContact} hasPrimary={activeContacts.some((c) => c.isPrimary)} initialOpen={preview?.contactOpen} initialState={preview?.contactState} />
              ) : null}
            </CardHeader>
            <CardBody>
              {activeContacts.length === 0 ? (
                <p className="m-0 text-quiet">No contact yet.{canEdit ? ' Add the person you call for rates and bookings.' : ''}</p>
              ) : (
                <ul className="m-0 flex list-none flex-col divide-y divide-line p-0" aria-label="Contacts">
                  {activeContacts.map((c) => (
                    <li key={c.contactId} className="m-0 flex flex-wrap items-start justify-between gap-2 py-3">
                      <span className="flex min-w-0 gap-2.5">
                        <ContactIcon />
                        <span className="min-w-0">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="font-semibold wrap-anywhere text-ink">{c.name}</span>
                            {c.roleLabel ? <span className="text-sm text-quiet">{c.roleLabel}</span> : null}
                            {c.isPrimary ? (
                              <StatusBadge tone="brand" icon={Star} wrap>
                                Primary
                              </StatusBadge>
                            ) : null}
                          </span>
                          {c.phone ? (
                            <span className="flex items-center gap-1.5 text-sm wrap-anywhere">
                              <Phone aria-hidden="true" className="size-3.5 text-faint" />
                              <span className="sr-only">Phone: </span>
                              {c.phone}
                            </span>
                          ) : null}
                          {c.email ? (
                            <span className="flex items-center gap-1.5 text-sm wrap-anywhere">
                              <Mail aria-hidden="true" className="size-3.5 text-faint" />
                              <span className="sr-only">E-mail: </span>
                              {c.email}
                            </span>
                          ) : null}
                        </span>
                      </span>
                      {canEdit && actions?.saveContact && actions.removeContact ? (
                        <span className="flex flex-wrap gap-1">
                          <ContactDialog supplierId={s.supplierId} contact={c} action={actions.saveContact} hasPrimary />
                          <RemoveContactDialog contact={c} action={actions.removeContact} isOnlyContact={activeContacts.length === 1} initialOpen={preview?.removeContactOpen && c === activeContacts[0]} />
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </section>
        </Card>
      ) : null}

      {tab === 'hotels' && sellsHotels ? (
        <Card>
          <section aria-labelledby="sup-hotels">
            <CardHeader className="max-sm:flex-col max-sm:items-start">
              <div className="min-w-0">
                <CardTitle id="sup-hotels">Hotels sold</CardTitle>
                <CardDescription>Hotels from the hotel list this supplier sells. A rate for a listed hotel adds the link by itself.</CardDescription>
              </div>
              {s.can.linkHotel && actions?.linkHotel && searchHotels ? (
                <LinkHotelDialog supplierId={s.supplierId} action={actions.linkHotel} searchHotels={searchHotels} initialOpen={preview?.linkOpen} initialState={preview?.linkState} />
              ) : !s.can.linkHotel && viewer !== 'flight' ? (
                <UnavailableAction label="Link a hotel" reason="Only Purchase links hotels to a supplier." />
              ) : null}
            </CardHeader>
            <CardBody>
              {s.hotels.length === 0 ? (
                <EmptyState icon={Hotel} title="No hotel linked yet" description="Add a rate for a listed hotel, or link one here." />
              ) : (
                <ul className="m-0 flex list-none flex-col divide-y divide-line p-0" aria-label="Hotels sold">
                  {s.hotels.map((h) => (
                    <li key={h.linkId} className="m-0 flex flex-wrap items-center justify-between gap-2 py-3">
                      <span className="flex min-w-0 items-start gap-2.5">
                        <Hotel aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-faint" />
                        <span className="min-w-0">
                          <span className="block font-semibold wrap-anywhere text-ink">{h.name}</span>
                          <span className="block text-sm text-quiet">{[h.city, HOTEL_SOURCE_WORD[h.source], `since ${formatIst(h.createdAt)}`].filter(Boolean).join(' · ')}</span>
                        </span>
                      </span>
                      {s.can.linkHotel && actions?.unlinkHotel ? <UnlinkHotelDialog link={h} action={actions.unlinkHotel} /> : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </section>
        </Card>
      ) : null}

      {tab === 'history' ? (
        <Card>
          <section aria-labelledby="sup-history">
            <CardHeader>
              <div className="min-w-0">
                <CardTitle id="sup-history">History</CardTitle>
                <CardDescription>The last 100 changes, newest first. Bank changes show the revision only, never account numbers.</CardDescription>
              </div>
            </CardHeader>
            {s.history.length === 0 ? (
              <CardBody>
                <p className="m-0 text-quiet">No changes recorded yet.</p>
              </CardBody>
            ) : (
              <Table stackOnMobile label="Supplier change history" wrapperClassName="rounded-card">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>When</TableHead>
                    <TableHead>Who</TableHead>
                    <TableHead>What</TableHead>
                    <TableHead>Before</TableHead>
                    <TableHead>After</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {s.history.map((h, i) => (
                    <TableRow key={`${h.changedAt}-${h.field}-${i}`} className="align-top">
                      <TableCell label="When" className="align-top whitespace-nowrap">
                        {formatIst(h.changedAt)}
                      </TableCell>
                      <TableCell label="Who" className="align-top">
                        {h.changedByName ?? <span className="text-quiet">Not recorded</span>}
                      </TableCell>
                      <TableCell label="What" className="align-top">
                        <span className="block font-medium text-ink">{fieldWord(h.field)}</span>
                        <span className="block text-sm text-quiet">{CHANGE_SOURCE_WORD[h.source]}</span>
                      </TableCell>
                      <TableCell label="Before" className="align-top wrap-anywhere">
                        {historyValueWord(h.field, h.oldValue) ?? <span className="text-quiet">Empty</span>}
                      </TableCell>
                      <TableCell label="After" className="align-top wrap-anywhere">
                        {historyValueWord(h.field, h.newValue) ?? <span className="text-quiet">Empty</span>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>
        </Card>
      ) : null}
    </div>
  );
}

function SupplierFacts({ s, states, showLedger }: { s: SupplierMaster; states: ReadonlyArray<{ code: string; name: string }>; showLedger: boolean }) {
  const row = (label: string, value: ReactNode) => (
    <div className="flex min-w-0 flex-col gap-0.5 border-b border-line py-2 sm:flex-row sm:gap-4">
      <dt className="text-sm text-quiet sm:w-40 sm:shrink-0">{label}</dt>
      <dd className="m-0 min-w-0 wrap-anywhere text-ink">{value ?? <span className="text-quiet">Not recorded</span>}</dd>
    </div>
  );
  return (
    <dl className="m-0">
      {row('Kind', KIND_LABEL[s.kind])}
      {row('Services', s.serviceTypes.map((t) => SERVICE_LABEL[t]).join(', '))}
      {row('City', s.city)}
      {row('State', stateText(s.stateCode, states))}
      {row('GSTIN', s.gstin)}
      {row('PAN', s.pan ?? s.panMasked)}
      {row('Address', s.address)}
      {s.serviceTypes.includes('flight') ? null : row('Payment terms', s.paymentTerms)}
      {showLedger ? row('Tally ledger', s.tallyLedgerName) : null}
      {s.sourceRef ? row('Import reference', s.sourceRef) : null}
      {row('Status', s.status === 'active' ? 'Active' : 'Archived')}
    </dl>
  );
}

/** Bank state from R-A2 when the bank details section is not shown here (revision, status and last 4 only). */
function BankSummary({ s }: { s: SupplierMaster }) {
  return (
    <Card>
      <section aria-labelledby="sup-bank-summary">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id="sup-bank-summary">Bank details</CardTitle>
            <CardDescription>A Manager who did not record them approves new bank details. Payments wait until then.</CardDescription>
          </div>
        </CardHeader>
        <CardBody>
          {s.bank ? (
            <p className="m-0 text-ink">
              Revision {s.bank.revisionNo} · {s.bank.status === 'approved' ? 'Approved' : 'Not approved yet'} ·{' '}
              <span className="whitespace-nowrap tabular-nums">
                <span aria-hidden="true">•••• </span>
                <span className="sr-only">account ending </span>
                {s.bank.accountLast4}
              </span>
            </p>
          ) : (
            <p className="m-0 text-quiet">No bank details recorded.</p>
          )}
        </CardBody>
      </section>
    </Card>
  );
}

export function SupplierPageLoading() {
  return (
    <div className="flex flex-col gap-4 font-sans">
      <h1 className="sr-only">Supplier</h1>
      <p role="status" aria-live="polite" className="m-0 text-sm font-medium text-quiet">
        Loading supplier…
      </p>
      <div aria-busy="true" className="flex flex-col gap-4">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-7 w-80 max-w-full" />
        <div className="flex gap-2">
          <Skeleton className="h-6 w-28 rounded-full" />
          <Skeleton className="h-6 w-44 rounded-full" />
        </div>
        <div className="flex gap-4 border-b border-line pb-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-5 w-20" />
          ))}
        </div>
        <div className="flex flex-col gap-3 rounded-card border border-line bg-card px-4.5 py-4 shadow-card">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </div>
    </div>
  );
}

/** The read failed (never "not found"). */
export function SupplierPageError({ backHref = '/app/purchase/suppliers' }: { backHref?: string }) {
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader title="Supplier" />
      <Notice tone="warning" role="status" title="The supplier could not be loaded">
        <p>Nothing was changed. Reload the page. If it keeps happening, tell your admin.</p>
      </Notice>
      <p className="m-0 mt-4">
        <Link href={backHref} className={buttonVariants({ variant: 'secondary' })}>
          Back to suppliers
        </Link>
      </p>
    </div>
  );
}
