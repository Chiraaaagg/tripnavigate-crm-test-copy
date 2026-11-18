import { BadgeCheck, Building2, CircleHelp, Landmark, SearchX, X } from 'lucide-react';
import Link from 'next/link';
import { StatusBadge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { TaskBackLink } from '@/views/department/task-frame';
import { SupplierDetailsForm } from './forms';
import { BANK_WORD, KIND_LABEL, SERVICE_LABEL, stateText, VERIFICATION_WORD } from './labels';
import type { SupplierBankState, SupplierKind, SupplierRegisterFilter, SupplierRegisterPage, SupplierRegisterRow, SupplierServiceType, SupplierVerification, SupplierViewer } from './types';

/*
 * Suppliers register (Accounts phase 2 contract 5.7 R-A1, 11.9). Search and
 * filters are a plain GET form, so the address keeps every filter and the
 * back button works; active filters show as removable chips with "Clear all".
 * "Show more" is a link to the next keyset page. From 640 px the table keeps
 * its columns and scrolls inside its own labelled region; under 640 px each
 * row is a labelled card, so the page never scrolls sideways. PAN is always
 * masked here. Purchase and Flight add suppliers below the list; Managers
 * and Accounts read (Managers verify on the supplier page).
 */

const TEXT: Record<SupplierViewer, { eyebrow: string; description: string; back: { href: string; label: string } | null }> = {
  purchase: { eyebrow: 'Purchase', description: 'Hotels, transfer and activity suppliers, agents and booking channels. New details stay “Not verified” until a Manager checks them.', back: { href: '/app/purchase', label: 'Back to Purchase tasks' } },
  flight: { eyebrow: 'Flight', description: 'Airlines and consolidators Flight pays. New details stay “Not verified” until a Manager checks them.', back: { href: '/app/flight', label: 'Back to Flight tasks' } },
  manager: { eyebrow: 'Suppliers', description: 'Read the suppliers of your company. Open a supplier to verify its details or approve bank details.', back: null },
  accounts: { eyebrow: 'Accounts', description: 'Read every supplier of your company, with GSTIN, PAN and bank state.', back: null },
};

export function SupplierStatusBadges({ row }: { row: Pick<SupplierRegisterRow, 'verification' | 'bankState'> }) {
  const v = VERIFICATION_WORD[row.verification];
  const b = BANK_WORD[row.bankState];
  return (
    <span className="flex flex-wrap gap-1.5">
      <StatusBadge tone={v.tone} icon={row.verification === 'verified' ? BadgeCheck : CircleHelp} wrap>
        <span className="sr-only">Details: </span>
        {v.word}
      </StatusBadge>
      <StatusBadge tone={b.tone} icon={Landmark} wrap>
        {b.word}
      </StatusBadge>
    </span>
  );
}

function filterHref(base: string, filter: SupplierRegisterFilter, drop?: keyof SupplierRegisterFilter, after?: string): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(filter)) if (v && k !== drop) p.set(k, String(v));
  if (after) p.set('after', after);
  const s = p.toString();
  return s ? `${base}?${s}` : base;
}

const VERIFICATION_FILTER: Record<SupplierVerification, string> = { verified: 'Verified', unverified: 'Not verified' };
const BANK_FILTER: Record<SupplierBankState, string> = { approved: 'Bank details approved', on_hold: 'Payments on hold', none: 'No bank details' };

function chipText(k: keyof SupplierRegisterFilter, v: string, hotelName?: string | null): string {
  switch (k) {
    case 'q':
      return `Search: ${v}`;
    case 'kind':
      return KIND_LABEL[v as SupplierKind] ?? v;
    case 'serviceType':
      return SERVICE_LABEL[v as SupplierServiceType] ?? v;
    case 'city':
      return `City: ${v}`;
    case 'verification':
      return VERIFICATION_FILTER[v as SupplierVerification] ?? v;
    case 'bankState':
      return BANK_FILTER[v as SupplierBankState] ?? v;
    case 'hotelId':
      return `Sells ${hotelName ?? 'the chosen hotel'}`;
    case 'status':
      return v === 'archived' ? 'Archived suppliers' : 'Active suppliers';
  }
}

export function SupplierRegisterView({
  viewer,
  filter,
  page,
  basePath = '/app/purchase/suppliers',
  states,
  serviceTypes,
  entities = [],
  createAction,
  hotelName,
  createInitialState,
}: {
  viewer: SupplierViewer;
  filter: SupplierRegisterFilter;
  page: SupplierRegisterPage | 'error';
  basePath?: string;
  states: ReadonlyArray<{ code: string; name: string }>;
  /** Service filter choices (and the create form's): Purchase hotel/transfer/activity, Flight flight only. */
  serviceTypes: SupplierServiceType[];
  /** Companies the viewer may add suppliers for (Purchase / Flight); empty = read only. */
  entities?: Array<{ id: string; name: string }>;
  createAction?: DecisionAction | null;
  /** Name of the filtered hotel (hotelId filter), for the chip. */
  hotelName?: string | null;
  createInitialState?: Parameters<typeof SupplierDetailsForm>[0]['initialState'];
}) {
  const t = TEXT[viewer];
  const active = (Object.entries(filter) as Array<[keyof SupplierRegisterFilter, string | undefined]>).filter(([, v]) => !!v) as Array<[keyof SupplierRegisterFilter, string]>;
  const canAdd = entities.length > 0 && !!createAction;
  const filtersOpen = active.some(([k]) => k !== 'q');
  return (
    <div className="flex flex-col gap-5 font-sans text-base text-copy">
      <div>
        {t.back ? <TaskBackLink href={t.back.href}>{t.back.label}</TaskBackLink> : null}
        <PageHeader
          eyebrow={t.eyebrow}
          title="Suppliers"
          description={t.description}
          className="mb-[0]"
          actions={
            canAdd ? (
              <a href="#supplier-add" className={buttonVariants({ variant: 'primary' })}>
                Add a supplier
              </a>
            ) : undefined
          }
        />
      </div>

      <Card>
        <CardBody className="flex flex-col gap-3">
          <form method="get" action={basePath} role="search" aria-label="Search suppliers" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end gap-2">
              <Field htmlFor="sup-q" label="Search" hint="Name (start of it), or an exact GSTIN or PAN." className="min-w-0 flex-1 basis-64">
                <Input id="sup-q" name="q" type="search" defaultValue={filter.q ?? ''} maxLength={80} autoComplete="off" spellCheck={false} aria-describedby="sup-q-hint" />
              </Field>
              <button type="submit" className={buttonVariants({ variant: 'secondary' })}>
                Search
              </button>
            </div>
            <details open={filtersOpen} className="rounded-control border border-line px-3 py-2">
              <summary className={cn('w-fit cursor-pointer rounded-chip font-medium text-brand-strong', focusRing)}>Filters</summary>
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
                <Field htmlFor="sup-kind" label="Kind">
                  <Select id="sup-kind" name="kind" defaultValue={filter.kind ?? ''}>
                    <option value="">Any</option>
                    {(['direct', 'channel'] as const).map((k) => (
                      <option key={k} value={k}>
                        {KIND_LABEL[k]}
                      </option>
                    ))}
                  </Select>
                </Field>
                {serviceTypes.length > 1 ? (
                  <Field htmlFor="sup-service" label="Service">
                    <Select id="sup-service" name="serviceType" defaultValue={filter.serviceType ?? ''}>
                      <option value="">Any</option>
                      {serviceTypes.map((s) => (
                        <option key={s} value={s}>
                          {SERVICE_LABEL[s]}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ) : null}
                <Field htmlFor="sup-city" label="City">
                  <Input id="sup-city" name="city" defaultValue={filter.city ?? ''} maxLength={120} autoComplete="off" />
                </Field>
                <Field htmlFor="sup-verification" label="Details">
                  <Select id="sup-verification" name="verification" defaultValue={filter.verification ?? ''}>
                    <option value="">Any</option>
                    <option value="unverified">Not verified</option>
                    <option value="verified">Verified</option>
                  </Select>
                </Field>
                <Field htmlFor="sup-status" label="Active or archived">
                  <Select id="sup-status" name="status" defaultValue={filter.status ?? ''}>
                    <option value="">Any</option>
                    <option value="active">Active</option>
                    <option value="archived">Archived</option>
                  </Select>
                </Field>
                <Field htmlFor="sup-bank" label="Bank details">
                  <Select id="sup-bank" name="bankState" defaultValue={filter.bankState ?? ''}>
                    <option value="">Any</option>
                    <option value="approved">Approved</option>
                    <option value="on_hold">Payments on hold</option>
                    <option value="none">None recorded</option>
                  </Select>
                </Field>
              </div>
              {filter.hotelId ? <input type="hidden" name="hotelId" value={filter.hotelId} /> : null}
              <div className="mt-3">
                <button type="submit" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
                  Apply filters
                </button>
              </div>
            </details>
          </form>
          {active.length > 0 ? (
            <ul className="m-0 flex list-none flex-wrap items-center gap-2 p-0" aria-label="Active filters">
              {active.map(([k, v]) => (
                <li key={k}>
                  <Link href={filterHref(basePath, filter, k)} className={cn('inline-flex min-h-8 items-center gap-1.5 rounded-full border border-line bg-wash px-3 text-sm text-ink no-underline hover:border-brand-strong', focusRing)}>
                    {chipText(k, v, hotelName)}
                    <X aria-hidden="true" className="size-3.5" />
                    <span className="sr-only">(remove this filter)</span>
                  </Link>
                </li>
              ))}
              <li>
                <Link href={basePath} className={cn('rounded-chip text-sm font-medium text-brand-strong underline underline-offset-4', focusRing)}>
                  Clear all
                </Link>
              </li>
            </ul>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        {page === 'error' ? (
          <CardBody>
            <Notice tone="warning" role="status" title="The suppliers could not be loaded">
              <p>Nothing was changed. Reload the page. If it keeps happening, tell your admin.</p>
            </Notice>
          </CardBody>
        ) : page.items.length === 0 ? (
          active.length > 0 ? (
            <EmptyState
              icon={SearchX}
              headingLevel={2}
              title="No supplier matches"
              description="Check the spelling, search by the start of the name, or remove a filter."
              action={
                <Link href={basePath} className={buttonVariants({ variant: 'secondary' })}>
                  Clear all filters
                </Link>
              }
            />
          ) : (
            <EmptyState icon={Building2} headingLevel={2} title="No suppliers yet" description={canAdd ? 'Add the first supplier below.' : 'Purchase and Flight add suppliers here.'} />
          )
        ) : (
          <RegisterTable rows={page.items} basePath={basePath} states={states} />
        )}
        {page !== 'error' && page.hasMore && page.nextAfter ? (
          <CardBody className="border-t border-line">
            <Link href={filterHref(basePath, filter, undefined, page.nextAfter)} className={buttonVariants({ variant: 'secondary' })}>
              Show more suppliers
            </Link>
          </CardBody>
        ) : null}
      </Card>

      {canAdd ? (
        <Card id="supplier-add">
          <section aria-labelledby="supplier-add-heading">
            <CardHeader>
              <div className="min-w-0">
                <CardTitle id="supplier-add-heading">Add a supplier</CardTitle>
                <CardDescription>If a supplier with the same GSTIN, PAN, bank account or a similar name in the same city exists, you are told after saving. Nothing is merged.</CardDescription>
              </div>
            </CardHeader>
            <CardBody>
              <SupplierDetailsForm mode="create" action={createAction!} entities={entities} states={states} serviceChoices={serviceTypes} initialState={createInitialState} />
            </CardBody>
          </section>
        </Card>
      ) : null}
    </div>
  );
}

function RegisterTable({ rows, basePath, states }: { rows: SupplierRegisterRow[]; basePath: string; states: ReadonlyArray<{ code: string; name: string }> }) {
  return (
    <Table stackOnMobile label="Suppliers table" wrapperClassName="rounded-card" className="sm:min-w-[56rem]">
      <TableCaption className="caption-top border-b border-line py-3 text-left font-medium text-copy max-sm:block">
        {rows.length} {rows.length === 1 ? 'supplier' : 'suppliers'} shown
      </TableCaption>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Supplier</TableHead>
          <TableHead>Services</TableHead>
          <TableHead>GSTIN and PAN</TableHead>
          <TableHead>Primary contact</TableHead>
          <TableHead numeric>Hotels sold</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((s) => (
          <TableRow key={s.supplierId} className="align-top">
            <TableCell label="Supplier" className="align-top">
              <span className="block text-xs font-medium text-quiet">{KIND_LABEL[s.kind]}</span>
              <Link href={`${basePath}/${s.supplierId}`} className={cn('rounded-chip font-semibold wrap-anywhere text-brand-strong underline-offset-4 hover:text-brand-deep hover:underline', focusRing)}>
                {s.name}
              </Link>
              <span className="block text-sm text-quiet">{[s.city, stateText(s.stateCode, states)].filter(Boolean).join(' · ') || 'City not recorded'}</span>
            </TableCell>
            <TableCell label="Services" className="align-top">
              {s.serviceTypes.map((x) => SERVICE_LABEL[x]).join(', ')}
            </TableCell>
            <TableCell label="GSTIN and PAN" className="align-top">
              <span className="block tabular-nums wrap-anywhere">{s.gstin ?? <span className="text-quiet">No GSTIN</span>}</span>
              <span className="block text-sm text-quiet tabular-nums">{s.panMasked ? `PAN ${s.panMasked}` : 'No PAN'}</span>
            </TableCell>
            <TableCell label="Primary contact" className="align-top">
              {s.primaryContact ? (
                <>
                  <span className="block wrap-anywhere">{s.primaryContact.name}</span>
                  <span className="block text-sm wrap-anywhere text-quiet">{[s.primaryContact.phone, s.primaryContact.email].filter(Boolean).join(' · ')}</span>
                </>
              ) : (
                <span className="text-quiet">No contact yet</span>
              )}
            </TableCell>
            <TableCell label="Hotels sold" numeric className="align-top">
              {s.serviceTypes.includes('hotel') ? s.hotelCount : <span className="text-quiet">—</span>}
            </TableCell>
            <TableCell label="Status" className="align-top">
              <SupplierStatusBadges row={s} />
              {s.status === 'archived' ? <span className="mt-[0.25rem] block text-sm text-quiet">Archived</span> : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Route loading file shape for the register. */
export function SupplierRegisterLoading() {
  return (
    <div className="flex flex-col gap-4 font-sans">
      <h1 className="sr-only">Suppliers</h1>
      <p role="status" aria-live="polite" className="m-0 text-sm font-medium text-quiet">
        Loading suppliers…
      </p>
      <div aria-busy="true" className="flex flex-col gap-4">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-96 max-w-full" />
        <div className="flex flex-col gap-3 rounded-card border border-line bg-card px-4.5 py-4 shadow-card">
          <Skeleton className="h-10 w-full" />
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}

/** The read returned null: not a supplier reader (same words whatever the reason). */
export function SupplierRegisterNoAccess() {
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader title="Suppliers" />
      <Notice tone="locked" role="status" title="Not available to you">
        <p>The supplier list is for Purchase, Flight, Accounts and branch Managers. Ask your admin if you need it.</p>
      </Notice>
    </div>
  );
}
