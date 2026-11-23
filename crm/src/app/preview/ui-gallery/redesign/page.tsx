import { ClipboardCheck } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { Fold } from '@/components/ui/fold';
import { JumpLinks } from '@/components/ui/jump-links';
import { QueueToolbar } from '@/components/ui/queue-toolbar';
import { RecordHeader } from '@/components/ui/record-header';
import { SectionTabs } from '@/components/ui/section-tabs';
import { StateBlock } from '@/components/ui/state-block';
import { STATUS_KINDS, Status, type StatusKind } from '@/components/ui/status';
import { Tabs } from '@/components/ui/tabs';
import { isUiPreviewEnabled } from '@/lib/config';
import { dateRangeText, dayText, plural, shortDate } from '@/lib/format';
import type { AccountsSectionViewer } from '@/views/accounts-desk/sections';
import { ApprovalRowsDemo, CollapsibleDemo, ConfirmDemos, RecordHeaderFormDemo, SwitchRowsDemo } from './redesign-demos';

/**
 * LOCAL DESIGN-REVIEW GALLERY of the redesign shared parts (UX redesign R0,
 * build plan 4.1): every new part in every state, with synthetic data.
 * 404 unless the preview gallery is enabled (see isUiPreviewEnabled), so it
 * never serves on Vercel. tests/e2e/ui-gallery.e2e.ts opens it under the
 * production style policy.
 */

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Redesign parts gallery' };

const HERE = '/preview/ui-gallery/redesign';

const ACCOUNTS_PERSON: AccountsSectionViewer = { canUseAccounts: true, canCheckCustomers: true, canSeeAccountsDesk: true, canSeeBranchMoney: false, canSeeOwnDues: false };
const BRANCH_MANAGER: AccountsSectionViewer = { canUseAccounts: false, canCheckCustomers: false, canSeeAccountsDesk: false, canSeeBranchMoney: true, canSeeOwnDues: false };

function Section({ id, title, description, children }: { id: string; title: string; description?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mb-10">
      <h2 id={id} className="m-0 text-xl leading-7 font-display tracking-heading text-ink">
        {title}
      </h2>
      {description ? <p className="m-0 mt-1.5 mb-4 max-w-[70ch] text-base text-quiet">{description}</p> : <div className="mb-4" />}
      {children}
    </section>
  );
}

function StateLabel({ children }: { children: ReactNode }) {
  return <p className="m-0 mb-1.5 text-xs font-semibold tracking-label text-faint uppercase">{children}</p>;
}

export default async function RedesignGalleryPage({ searchParams }: { searchParams: Promise<{ q?: string; sort?: string; filter?: string }> }) {
  if (!isUiPreviewEnabled(process.env)) notFound();
  const { q = '', sort = 'oldest', filter = 'mine' } = await searchParams;
  const chip = (key: string, label: string, count?: number | 'unknown') => ({
    href: `${HERE}?filter=${key}`,
    label,
    count,
    current: filter === key,
  });

  return (
    <div className="min-h-dvh bg-canvas font-sans text-base text-copy antialiased">
      <main id="main" className="mx-auto max-w-[74rem] px-4 pt-6 pb-16 sm:px-7">
        <p className="m-0 mb-5 w-fit rounded-control border border-dashed border-line-strong bg-card px-2.5 py-1.5 text-sm text-quiet">
          Redesign parts gallery (R0): every name, record and amount on this page is made up. Changes here save nothing.
        </p>
        <h1 className="m-0 mb-2 text-2xl leading-tight font-display tracking-heading text-ink">Redesign shared parts</h1>
        <p className="m-0 mb-6 text-base text-quiet">
          <Link href="/preview/ui-gallery" className={cn('rounded-chip font-medium text-brand-strong underline underline-offset-4', focusRing)}>
            Back to the design system gallery
          </Link>
        </p>

        <JumpLinks
          links={[
            { targetId: 'g-r-status', label: 'Status' },
            { targetId: 'g-r-header', label: 'Record header' },
            { targetId: 'g-r-toolbar', label: 'Queue toolbar' },
            { targetId: 'g-r-tabs', label: 'Tabs' },
            { targetId: 'g-r-switch', label: 'Switch rows' },
            { targetId: 'g-r-states', label: 'States' },
            { targetId: 'g-r-folded-target', label: 'A field inside a closed fold' },
          ]}
        />

        <Section id="g-r-status" title="Status (C3)" description="One table: every kind has a tone, an icon and words. An unknown kind shows neutral with a clock.">
          <Card>
            <CardBody className="flex flex-col gap-4">
              <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label="Every status kind">
                {STATUS_KINDS.map((k) => (
                  <li key={k} className="m-0">
                    <Status kind={k} />
                  </li>
                ))}
              </ul>
              <div className="flex flex-col gap-2">
                <StateLabel>With a second fact, page words, unknown kind, wrapping</StateLabel>
                <Status kind="waiting_for_manager" second="Raised 6 Nov 2026" />
                <Status kind="confirmed" label="Confirmed by Sample Hotel A" />
                <Status kind={'no_such_kind' as StatusKind} label="Sample unknown state" />
                <span className="block w-56">
                  <Status kind="returned_by_accounts" label="Returned by Accounts: the advance receipt is missing its reference" wrap />
                </span>
              </div>
            </CardBody>
          </Card>
        </Section>

        <Section id="g-r-header" title="Record header (C4)" description="Back link and ID; title, status, owner; Next with the one primary button; read-only line; folded details.">
          <div className="flex flex-col gap-6">
            <div>
              <StateLabel>Next jumps to a control on this page</StateLabel>
              <RecordHeader
                back={{ href: HERE, label: 'Deals' }}
                recordId="SAMPLE-BX-38412"
                title="SAMPLE — Goa family trip"
                status={<Status kind="booking_in_progress" />}
                owner="Sample Sales A"
                next={{ text: 'Add the hotel for night 3 to finish the booking.', button: { label: 'Go to services', jumpTo: 'g-r-folded-target' } }}
                actions={<Button size="sm" variant="ghost">Copy link</Button>}
                details={
                  <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                    <dt className="text-quiet">Bitrix number</dt>
                    <dd className="m-0">38412</dd>
                    <dt className="text-quiet">Created</dt>
                    <dd className="m-0">{dayText('2026-11-02T09:30:00Z')}</dd>
                  </dl>
                }
              />
            </div>
            <div>
              <StateLabel>Next opens another page</StateLabel>
              <RecordHeader
                back={{ href: HERE, label: 'Quotations' }}
                recordId="SAMPLE-Q-77"
                title="Quotation for SAMPLE — Kerala backwaters"
                status={<Status kind="sent" second="Shared 12 Nov 2026" />}
                owner="Sample Sales B"
                next={{ text: 'The customer accepted. Start the booking.', button: { label: 'Start booking', href: HERE } }}
              />
            </div>
            <div>
              <StateLabel>Next posts the page&apos;s action</StateLabel>
              <RecordHeaderFormDemo />
            </div>
            <div>
              <StateLabel>Viewer cannot act: who does, and read only</StateLabel>
              <RecordHeader
                back={{ href: HERE, label: 'Deals' }}
                recordId="SAMPLE-BX-38420"
                title="SAMPLE — Manali snow trip"
                status={<Status kind="waiting_for_accounts" />}
                owner="Sample Sales C"
                nextWho="Accounts checks the booking."
                readOnly="You can view this. Accounts can change it."
              />
            </div>
            <div>
              <StateLabel>Disabled primary button</StateLabel>
              <RecordHeader
                back={{ href: HERE, label: 'Visa and passport tasks' }}
                title="Visa for SAMPLE — Dubai family"
                status={<Status kind="on_hold" />}
                next={{ text: 'Waiting for the passport copies.', button: { label: 'Submit application', disabled: true } }}
              />
            </div>
          </div>
        </Section>

        <Section id="g-r-toolbar" title="Queue toolbar (C2)" description="Search (Enter), chips (first four, the rest under More), sort (submits on change; Sort button without script).">
          <Card>
            <CardBody className="flex flex-col gap-5">
              <QueueToolbar
                action={HERE}
                label="Search and filter sample tasks"
                chipsLabel="Sample task filters"
                keep={filter === 'mine' ? undefined : { filter }}
                search={{ name: 'q', value: q, label: 'Search sample tasks', placeholder: 'Search by Deal, customer or hotel' }}
                chips={[
                  chip('mine', 'Mine', 3),
                  chip('not-taken', 'Not taken', 12),
                  chip('waiting', 'Waiting for supplier', 4),
                  chip('returned', 'Returned', 'unknown'),
                  chip('done', 'Done', 128),
                  chip('cancelled', 'Cancelled', 2),
                ]}
                sort={{
                  name: 'sort',
                  value: sort,
                  options: [
                    { value: 'oldest', label: 'Oldest first' },
                    { value: 'travel', label: 'Travel date' },
                    { value: 'newest', label: 'Newest first' },
                  ]}}
              />
              <p className="m-0 text-sm text-quiet">
                Shown for: filter {filter}, sort {sort}
                {q ? `, search “${q}”` : ''}.
              </p>
            </CardBody>
          </Card>
          <div className="mt-4">
            <StateLabel>Approval rows: Approve and Return; blocked (own request)</StateLabel>
            <ApprovalRowsDemo />
          </div>
        </Section>

        <Section id="g-r-tabs" title="Tabs (C5) and Accounts section tabs (D5)" description="Still links with aria-current. Pill look with counts; 'count not known' as a dash. The original underline look stays the default.">
          <div className="flex flex-col gap-5">
            <div>
              <StateLabel>Pill with counts (one not known)</StateLabel>
              <Tabs
                variant="pill"
                label="Sample queue views"
                items={[
                  { href: `${HERE}?view=mine`, label: 'Mine', count: 3, current: true },
                  { href: `${HERE}?view=not-taken`, label: 'Not taken', count: 12 },
                  { href: `${HERE}?view=all`, label: 'All', count: 'unknown' },
                ]}
              />
            </div>
            <div>
              <StateLabel>Pill without counts (record tabs)</StateLabel>
              <Tabs
                variant="pill"
                label="Sample record tabs"
                items={[
                  { href: `${HERE}?tab=overview`, label: 'Overview' },
                  { href: `${HERE}?tab=services`, label: 'Services and tasks', current: true },
                  { href: `${HERE}?tab=money`, label: 'Money' },
                  { href: `${HERE}?tab=documents`, label: 'Documents' },
                  { href: `${HERE}?tab=messages`, label: 'Messages' },
                  { href: `${HERE}?tab=history`, label: 'History' },
                ]}
              />
            </div>
            <div>
              <StateLabel>Underline (default, unchanged)</StateLabel>
              <Tabs
                label="Sample underline tabs"
                items={[
                  { href: `${HERE}?u=reviews`, label: 'Booking reviews', current: true, count: 2 },
                  { href: `${HERE}?u=receipts`, label: 'Receipts to verify' },
                ]}
              />
            </div>
            <div>
              <StateLabel>Accounts person: Money out (current Supplier payments)</StateLabel>
              <SectionTabs
                section="money-out"
                currentHref="/app/accounts/supplier-payments"
                viewer={ACCOUNTS_PERSON}
                counts={{ '/app/accounts/go-ahead': 2, '/app/accounts/supplier-payments': 5, '/app/accounts/supplier-invoices': 0, '/app/accounts/funding': 'unknown' }}
              />
            </div>
            <div>
              <StateLabel>Branch Manager: Money in (only the tabs they may open; current on a sub-page)</StateLabel>
              <SectionTabs section="money-in" currentHref="/app/accounts/small-balances/monthly" viewer={BRANCH_MANAGER} counts={{ '/app/accounts/dues': 7 }} />
            </div>
            <div>
              <StateLabel>One-tab section (Tally): no strip</StateLabel>
              <SectionTabs section="tally" currentHref="/app/accounts/tally" viewer={ACCOUNTS_PERSON} />
              <p className="m-0 text-sm text-quiet">Nothing above: a section with one tab has nothing to switch.</p>
            </div>
          </div>
        </Section>

        <Section id="g-r-switch" title="Switch rows (C6) and the confirm dialog (C7)" description="State in words; Change opens one confirm dialog. Type “refuse” in a reason to see a refusal (the typed reason stays).">
          <div className="flex flex-col gap-5">
            <SwitchRowsDemo />
            <div>
              <StateLabel>Confirm dialog: no reason, optional reason, required reason</StateLabel>
              <ConfirmDemos />
            </div>
          </div>
        </Section>

        <Section id="g-r-states" title="Screen states (C8)" description="Empty, error, blocked, read only, switched off, not known.">
          <div className="grid gap-4 lg:grid-cols-2">
            <StateBlock kind="empty" icon={ClipboardCheck} title="Nothing to check" text="New bookings and receipts appear here when Sales sends them." action={<Link href={HERE} className={buttonVariants({ variant: 'secondary' })}>See checked bookings</Link>} />
            <StateBlock kind="error" title="The receipt list did not load" text="The CRM could not read the receipts just now." saved={false} who="If it keeps happening, tell the Super Admin." action={<Link href={HERE} className={buttonVariants({ size: 'sm' })}>Try again</Link>} />
            <Card>
              <CardBody className="flex flex-col gap-4">
                <StateBlock kind="blocked" action={<Button size="sm" disabled>Verify receipt SAMPLE-R-102</Button>} text="You recorded this receipt, so a different Accounts person verifies it." />
                <StateBlock kind="readOnly" who="Accounts can change it." />
                <p className="m-0 text-base">
                  Supplier balance: <StateBlock kind="unknown" />
                </p>
              </CardBody>
            </Card>
            <StateBlock kind="off" text="Visa and passport tasks are switched off. Bookings with a visa wait here." who="A Super Admin switches it on in Settings › Features." action={<Link href={HERE} className={buttonVariants({ size: 'sm' })}>Open Features</Link>} />
            <StateBlock kind="error" title="Saved, but the e-mail did not go" text="The receipt is recorded." saved />
          </div>
        </Section>

        <Section id="g-r-folds" title="Folds (C11) and in-page jumps" description="Native folds, no height animation. A jump opens a closed fold around its target and moves focus there. Menu groups use the Collapsible.">
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="flex flex-col gap-3">
              <Fold summary="System details" meta="4 facts">
                <p className="m-0 text-sm">Sample Bitrix number 38412, synced {dayText('2026-11-14T04:00:00Z')}.</p>
              </Fold>
              <Fold summary="Finished payment requests" meta="3 paid" open>
                <ul className="m-0 pl-5 text-sm">
                  <li>SAMPLE-P-90 · paid 2 Nov 2026</li>
                  <li>SAMPLE-P-91 · paid 4 Nov 2026</li>
                </ul>
              </Fold>
              <Card>
                <CardHeader>
                  <CardTitle level={3}>A card with a flat fold</CardTitle>
                </CardHeader>
                <CardBody className="text-sm">Card content.</CardBody>
                <Fold flat summary="Add a rate" id="g-r-fold-rates">
                  <label htmlFor="g-r-folded-target" className="block text-sm font-semibold text-ink">
                    Sample rate per night
                  </label>
                  <input id="g-r-folded-target" className="mt-1 rounded-control border border-control px-3 py-2 focus:outline-2 focus:outline-solid focus:outline-brand-strong" defaultValue="4,500" />
                </Fold>
              </Card>
            </div>
            <div className="flex flex-col gap-3">
              <StateLabel>Menu groups: one open, one closed on first load</StateLabel>
              <CollapsibleDemo />
              <StateLabel>Dates and counts (src/lib/format.ts)</StateLabel>
              <ul className="m-0 pl-5 text-sm">
                <li>{dayText('2026-11-06')}</li>
                <li>{shortDate('2026-11-06')}</li>
                <li>{dateRangeText('2026-11-28', '2026-12-02')}</li>
                <li>{dateRangeText('2026-12-28', '2027-01-02')}</li>
                <li>{plural(1, 'receipt')}, {plural(1250, 'entry', 'entries')}</li>
              </ul>
            </div>
          </div>
        </Section>
      </main>
    </div>
  );
}
