import {
  Banknote,
  Bell,
  Briefcase,
  CircleCheck,
  Clock,
  House,
  Inbox,
  Plus,
  Receipt,
  Search,
  Shield,
  ShoppingCart,
  Users,
} from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { StatusBadge, CountBadge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox, ChoiceGroup, Radio } from '@/components/ui/choice';
import { ChipCheck } from '@/components/ui/chip-check';
import { cn } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorSummary } from '@/components/ui/error-summary';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Fieldset } from '@/components/ui/fieldset';
import { Input } from '@/components/ui/input';
import { MobileNav } from '@/components/ui/mobile-nav';
import { MoneyInput } from '@/components/ui/money-input';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { Select } from '@/components/ui/select';
import { Sidebar, SidebarNav, Wordmark, type NavSection } from '@/components/ui/sidebar-nav';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import { StatCard } from '@/components/ui/stat-card';
import { StepNav } from '@/components/ui/stepper';
import { NotEntered, SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Timeline } from '@/components/ui/timeline';
import { isUiPreviewEnabled } from '@/lib/config';
import { DialogDemo, DrawerDemo, GalleryProviders, MenuDemo, RefreshDemo, ToastDemo, TooltipDemo } from './gallery-demos';

/**
 * LOCAL DESIGN-REVIEW GALLERY of the shared design system
 * (src/components/ui). Every component in its states with synthetic data.
 * 404 unless the preview gallery is enabled (APP_ENV=local, NODE_ENV=development,
 * ENABLE_UI_PREVIEW=true; see isUiPreviewEnabled), so it never serves on Vercel.
 *
 * Hover and keyboard-focus looks are shown statically with
 * data-preview-state (see the custom variants in tokens.css).
 */

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Design system gallery' };

const NAV: NavSection[] = [
  {
    items: [
      { href: '/preview/ui-gallery', label: 'Home', icon: <House />, current: true },
      { href: '/preview/ui-gallery?section=deals', label: 'Deals', icon: <Briefcase />, count: 4 },
      { href: '/preview/ui-gallery?section=leads', label: 'Leads', icon: <Users /> },
      { href: '/preview/ui-gallery?section=accounts', label: 'Accounts', icon: <Banknote /> },
    ],
  },
  {
    label: 'Back office',
    items: [
      { href: '/preview/ui-gallery?section=purchase', label: 'Purchase', icon: <ShoppingCart /> },
      { href: '/preview/ui-gallery?section=admin', label: 'Admin', icon: <Shield /> },
    ],
  },
];

const DEALS = [
  { name: 'SAMPLE — Goa family trip', sub: 'Sample Customer A · 4 nights · 2 adults, 2 children', tone: 'brand', stage: 'Quote sent', next: 'Follow up on quote', due: 'Today', value: '₹1,84,500' },
  { name: 'SAMPLE — Udaipur weekend', sub: 'Sample Customer B · 2 nights · 2 adults', tone: 'warning', stage: 'Waiting for customer', next: 'Ask travel dates', due: 'Tomorrow', value: '₹46,200' },
  { name: 'SAMPLE — Kerala backwaters', sub: 'Sample Customer C · 6 nights · 4 adults', tone: 'success', stage: 'Confirmed', next: 'Share vouchers', due: '12 Oct', value: '₹3,12,000' },
  { name: 'SAMPLE — Manali snow trip', sub: 'Sample Customer D · 5 nights · 2 adults', tone: 'info', stage: 'New enquiry', next: 'Call customer', due: '13 Oct', value: '—' },
  { name: 'SAMPLE — Andaman islands', sub: 'Sample Customer F · 5 nights · 2 adults', tone: 'danger', stage: 'Payment overdue', next: 'Remind about advance', due: 'Overdue', value: '₹2,05,000' },
] as const;

const SWATCHES = [
  { name: 'brand', hex: '#0D9488', use: 'Icons, large shapes', className: 'bg-brand' },
  { name: 'brand-strong', hex: '#0F766E', use: 'Text, buttons (5.47:1)', className: 'bg-brand-strong' },
  { name: 'brand-deep', hex: '#115E59', use: 'Active nav, hover (7.58:1)', className: 'bg-brand-deep' },
  { name: 'brand-tint-2', hex: '#CCFBF1', use: 'Avatars, highlights', className: 'bg-brand-tint-2' },
  { name: 'brand-tint', hex: '#F0FDFA', use: 'Selected backgrounds', className: 'bg-brand-tint' },
  { name: 'ink', hex: '#0F172A', use: 'Headings (17.85:1)', className: 'bg-ink' },
  { name: 'copy', hex: '#334155', use: 'Body text (10.35:1)', className: 'bg-copy' },
  { name: 'quiet', hex: '#475569', use: 'Secondary text (7.58:1)', className: 'bg-quiet' },
  { name: 'faint', hex: '#64748B', use: 'Tertiary, white/canvas only', className: 'bg-faint' },
  { name: 'line', hex: '#E2E8F0', use: 'Dividers', className: 'bg-line' },
  { name: 'canvas', hex: '#F8FAFC', use: 'Page background', className: 'bg-canvas' },
  { name: 'wash', hex: '#F1F5F9', use: 'Hover, quiet fills', className: 'bg-wash' },
];

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

export default function UiGalleryPage() {
  if (!isUiPreviewEnabled(process.env)) notFound();

  return (
    <GalleryProviders>
      <div className="flex min-h-dvh bg-canvas font-sans text-base text-copy antialiased">
        <Sidebar
          sections={NAV}
          footer={
            <>
              Design system gallery
              <br />
              All data is made up.
            </>
          }
        />
        <div className="min-w-0 flex-1">
          <header className="sticky top-0 z-10 flex h-15 items-center gap-3 border-b border-line bg-card px-4 sm:px-7">
            <MobileNav>
              <SidebarNav sections={NAV} />
            </MobileNav>
            <span className="lg:hidden">
              <Wordmark />
            </span>
            <div className="hidden w-80 items-center gap-2 rounded-control border border-line bg-canvas px-2.5 py-1.5 text-faint md:flex">
              <Search aria-hidden="true" className="size-4" />
              <span>Search Deals, Leads, people…</span>
            </div>
            <div className="flex-1" />
            <Button variant="ghost" size="icon" aria-label="Notifications, 3 unread">
              <Bell aria-hidden="true" />
            </Button>
            <span aria-hidden="true" className="grid size-8 place-items-center rounded-full bg-brand-tint-2 text-xs font-semibold text-brand-deep">
              AR
            </span>
          </header>

          <main id="main" className="mx-auto max-w-[74rem] px-4 pt-6 pb-16 sm:px-7">
            <p className="m-0 mb-5 flex w-fit items-center gap-2 rounded-control border border-dashed border-line-strong bg-card px-2.5 py-1.5 text-sm text-quiet">
              <Clock aria-hidden="true" className="size-3.5" />
              Design system gallery: every name, Deal and amount on this page is made up.
            </p>

            <PageHeader
              eyebrow="SAMPLE-DEL-001"
              title="Good morning, Asha"
              description="Thursday, 9 October · 3 things need you today"
              status={
                <>
                  <StatusBadge tone="warning">Waiting for customer</StatusBadge>
                  <span>Owner: Asha R. (sample)</span>
                </>
              }
              actions={
                <>
                  <Button variant="secondary">Export list</Button>
                  <Button variant="primary">
                    <Plus aria-hidden="true" /> New Deal
                  </Button>
                </>
              }
            />

            <Section id="g-colours" title="Colours" description="Lagoon tokens. Brand teal #0D9488 is for icons and large shapes only; text and buttons use brand-strong.">
              <ul className="m-0 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-3 lg:grid-cols-6">
                {SWATCHES.map((s) => (
                  <li key={s.name} className="m-0 overflow-hidden rounded-card border border-line bg-card">
                    <div className={cn('h-12 border-b border-line', s.className)} />
                    <div className="px-2.5 py-2">
                      <p className="m-0 text-sm font-semibold text-ink">{s.name}</p>
                      <p className="m-0 font-mono text-xs text-quiet">{s.hex}</p>
                      <p className="m-0 text-xs text-quiet">{s.use}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </Section>

            <Section id="g-type" title="Type" description="Inter, self-hosted. Body text is 14px; money and counts use tabular figures.">
              <Card>
                <CardBody className="flex flex-col gap-2">
                  <p className="m-0 text-3xl font-display tracking-display text-ink">28 · Stat value ₹1,84,500</p>
                  <p className="m-0 text-2xl font-display tracking-heading text-ink">24 · Page title</p>
                  <p className="m-0 text-xl font-semibold text-ink">20 · Section title</p>
                  <p className="m-0 text-lg font-semibold text-ink">16 · Card title</p>
                  <p className="m-0 text-base text-copy">14 · Body text for everyday reading in lists and forms.</p>
                  <p className="m-0 text-sm text-quiet">13 · Secondary text, hints and table meta.</p>
                  <p className="m-0 text-xs font-semibold tracking-label text-faint uppercase">12 · Group label</p>
                </CardBody>
              </Card>
            </Section>

            <Section id="g-buttons" title="Buttons" description="One primary action per screen. Loading keeps the label and blocks double submits.">
              <Card>
                <CardBody className="flex flex-col gap-5">
                  {(['primary', 'secondary', 'ghost', 'danger', 'link'] as const).map((variant) => (
                    <div key={variant}>
                      <StateLabel>{variant}</StateLabel>
                      <div className="flex flex-wrap items-center gap-3">
                        <Button variant={variant}>Default</Button>
                        <Button variant={variant} data-preview-state="hover">
                          Hover
                        </Button>
                        <Button variant={variant} data-preview-state="focus">
                          Focus visible
                        </Button>
                        <Button variant={variant} disabled>
                          Disabled
                        </Button>
                        {variant === 'link' ? null : (
                          <Button variant={variant} loading>
                            Saving…
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                  <div>
                    <StateLabel>Sizes, icon button, link styled as a button</StateLabel>
                    <div className="flex flex-wrap items-center gap-3">
                      <Button size="sm">Small</Button>
                      <Button size="md">Medium</Button>
                      <Button size="lg">Large</Button>
                      <Button size="icon" aria-label="Add a traveller">
                        <Plus aria-hidden="true" />
                      </Button>
                      <Link href="/preview" className={buttonVariants({ variant: 'secondary' })}>
                        Back to preview list
                      </Link>
                    </div>
                  </div>
                </CardBody>
              </Card>
            </Section>

            <Section id="g-forms" title="Form controls" description="Native controls: labels always visible, errors say what to do, typed values are kept.">
              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardTitle level={3}>Text inputs</CardTitle>
                  </CardHeader>
                  <CardBody className="flex flex-col gap-4">
                    <Field htmlFor="g-name" label="Customer name" hint="As written on their ID.">
                      <Input id="g-name" placeholder="e.g. Sample Customer A" aria-describedby={fieldDescribedBy('g-name', { hint: true })} />
                    </Field>
                    <Field htmlFor="g-hover" label="Hover">
                      <Input id="g-hover" defaultValue="Sample Customer B" data-preview-state="hover" />
                    </Field>
                    <Field htmlFor="g-focus" label="Focus visible">
                      <Input id="g-focus" defaultValue="Sample Customer C" data-preview-state="focus" />
                    </Field>
                    <Field htmlFor="g-disabled" label="Branch" hint="Set by your account. Ask a Manager to change it.">
                      <Input id="g-disabled" defaultValue="Jodhpur" disabled aria-describedby={fieldDescribedBy('g-disabled', { hint: true })} />
                    </Field>
                    <Field htmlFor="g-error" label="Travel date" error="Travel date is in the past. Choose today or later.">
                      <Input
                        id="g-error"
                        type="date"
                        defaultValue="2026-09-01"
                        invalid
                        aria-describedby={fieldDescribedBy('g-error', { error: true })}
                      />
                    </Field>
                  </CardBody>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle level={3}>Select, textarea, choices</CardTitle>
                  </CardHeader>
                  <CardBody className="flex flex-col gap-4">
                    <Field htmlFor="g-select" label="Hotel category">
                      <Select id="g-select" defaultValue="4">
                        <option value="3">3 star</option>
                        <option value="4">4 star</option>
                        <option value="5">5 star</option>
                      </Select>
                    </Field>
                    <Field htmlFor="g-select-error" label="Room type" error="Choose a room type.">
                      <Select id="g-select-error" defaultValue="" invalid aria-describedby={fieldDescribedBy('g-select-error', { error: true })}>
                        <option value="" disabled>
                          Choose…
                        </option>
                        <option value="double">Double</option>
                        <option value="family">Family</option>
                      </Select>
                    </Field>
                    <Field htmlFor="g-notes" label="Notes for Purchase" optional>
                      <Textarea id="g-notes" defaultValue="Ground-floor room preferred for a sample traveller." rows={3} />
                    </Field>
                    <ChoiceGroup id="g-meals" legend="Meals included">
                      <Checkbox id="g-meal-1" name="meals" label="Breakfast" defaultChecked />
                      <Checkbox id="g-meal-2" name="meals" label="Dinner" description="Charged per night." />
                      <Checkbox id="g-meal-3" name="meals" label="Lunch (not offered by this sample hotel)" disabled />
                    </ChoiceGroup>
                    <ChoiceGroup id="g-payer" legend="Who pays the hotel?" error="Choose who pays before sending to Accounts.">
                      <Radio id="g-pay-1" name="payer" label="Customer advance" invalid />
                      <Radio id="g-pay-2" name="payer" label="Company funds" description="Accounts approves every company-funded commitment." invalid />
                    </ChoiceGroup>
                  </CardBody>
                </Card>
              </div>
            </Section>

            <Section id="g-status" title="Status pills" description="Always an icon and a word, never colour alone.">
              <Card>
                <CardBody className="flex flex-wrap gap-2">
                  <StatusBadge tone="info">New enquiry</StatusBadge>
                  <StatusBadge tone="brand">Quote sent</StatusBadge>
                  <StatusBadge tone="warning">Waiting for customer</StatusBadge>
                  <StatusBadge tone="success">Confirmed</StatusBadge>
                  <StatusBadge tone="neutral">On hold</StatusBadge>
                  <StatusBadge tone="danger">Payment overdue</StatusBadge>
                  <StatusBadge tone="success" icon={CircleCheck}>
                    Receipt verified
                  </StatusBadge>
                </CardBody>
              </Card>
            </Section>

            <Section id="g-stats" title="Stat cards">
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
                <StatCard label="Open Deals" value="12" note="3 new this week" icon={Briefcase} />
                <StatCard label="Waiting for customer" value="4" note="Oldest: 3 days" icon={Clock} />
                <StatCard label="Due today" value="3" note="1 is overdue" icon={CircleCheck} />
                <StatCard label="Receipts to check" value="2" note="₹48,000 in total" icon={Receipt} />
              </div>
            </Section>

            <Section id="g-tabs" title="Tabs" description="Links, not a script widget: each tab is its own address.">
              <Tabs
                label="Deal views"
                items={[
                  { href: '/preview/ui-gallery', label: 'Mine', current: true },
                  { href: '/preview/ui-gallery?view=action', label: 'Needs action', count: 3 },
                  { href: '/preview/ui-gallery?view=waiting', label: 'Waiting for customer', count: 4 },
                  { href: '/preview/ui-gallery?view=confirmed', label: 'Confirmed' },
                ]}
              />
            </Section>

            <Section id="g-table" title="Table" description="Right-aligned money, hairline rows; under 640px rows become labelled cards.">
              <Card>
                <CardHeader>
                  <CardTitle level={3}>Deals</CardTitle>
                  <CountBadge aria-label="5 sample Deals">5</CountBadge>
                </CardHeader>
                <Table label="Sample Deals" stackOnMobile>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Deal</TableHead>
                      <TableHead>Stage</TableHead>
                      <TableHead>Next step</TableHead>
                      <TableHead>Due</TableHead>
                      <TableHead numeric>Quote value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {DEALS.map((d) => (
                      <TableRow key={d.name}>
                        <TableCell label="Deal">
                          <p className="m-0 font-semibold text-ink">{d.name}</p>
                          <p className="m-0 text-sm text-quiet">{d.sub}</p>
                        </TableCell>
                        <TableCell label="Stage">
                          <StatusBadge tone={d.tone}>{d.stage}</StatusBadge>
                        </TableCell>
                        <TableCell label="Next step">{d.next}</TableCell>
                        <TableCell label="Due">{d.due}</TableCell>
                        <TableCell label="Quote value" numeric>
                          {d.value}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <CardFooter>
                  <span>Showing 5 of 12 sample Deals</span>
                  <Link href="/preview/ui-gallery?page=2" className={buttonVariants({ size: 'sm' })}>
                    Next page
                  </Link>
                </CardFooter>
              </Card>
            </Section>

            <Section id="g-overlays" title="Dialog, side panel, menu, tooltip, toast" description="Open each one with the mouse or the keyboard (Tab, Enter, Escape).">
              <Card>
                <CardBody className="flex flex-col gap-5">
                  <div className="flex flex-wrap gap-3">
                    <DialogDemo />
                    <DrawerDemo />
                    <MenuDemo />
                    <RefreshDemo />
                  </div>
                  <div>
                    <StateLabel>Tooltip (hover or focus)</StateLabel>
                    <TooltipDemo />
                  </div>
                  <div>
                    <StateLabel>Toast (success and info close by themselves; warning and error stay)</StateLabel>
                    <ToastDemo />
                  </div>
                </CardBody>
              </Card>
            </Section>

            <Section id="g-steps" title="Stepped forms" description="Step list, refusal summary, callouts, rupee input, grouped fields, participation chips, summaries and history (B1.1).">
              <div className="grid items-start gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
                <StepNav
                  label="Sample form steps"
                  steps={[
                    { key: 'a', label: 'Customer and billing', href: '/preview/ui-gallery#g-steps', status: 'complete' },
                    { key: 'b', label: 'Trip and travellers', href: '/preview/ui-gallery#g-steps', status: 'needs_input', current: true },
                    { key: 'c', label: 'Services', href: '/preview/ui-gallery#g-steps', status: 'warnings' },
                    { key: 'd', label: 'Review and submit', href: '/preview/ui-gallery#g-steps', status: 'not_started' },
                  ]}
                />
                <div className="flex min-w-0 flex-col gap-4">
                  <ErrorSummary
                    focusOnMount={false}
                    title="Check these fields:"
                    description="Nothing was stored; your typed values are still in the form."
                    items={[{ fieldId: 'g-amount', text: 'Enter the amount in rupees.' }]}
                  />
                  <Notice tone="restricted" title="Private identity details">
                    <p>Only the Deal owner, the branch Manager and the assigned desk see these.</p>
                  </Notice>
                  <Notice tone="warning">Visa tasks are switched off. This service waits and still counts as outstanding.</Notice>
                  <Fieldset legend="Sample traveller 1" columns={2}>
                    <Field htmlFor="g-amount" label="Amount ₹" error="Enter the amount in rupees.">
                      <MoneyInput id="g-amount" name="amount" invalid aria-describedby={fieldDescribedBy('g-amount', { error: true })} />
                    </Field>
                    <div className="flex flex-col gap-1.5">
                      <span className="font-sans text-base font-semibold text-ink">Who takes part</span>
                      <div className="flex flex-wrap gap-2">
                        <ChipCheck id="g-chip-1" label="Sample Traveller A" defaultChecked />
                        <ChipCheck id="g-chip-2" label="Sample Traveller B" />
                      </div>
                    </div>
                  </Fieldset>
                  <Card>
                    <CardBody className="grid gap-5 md:grid-cols-2">
                      <SummaryList>
                        <SummaryRow label="List price" numeric>₹1,00,000.00</SummaryRow>
                        <SummaryRow label="Discount" numeric><NotEntered /></SummaryRow>
                        <SummaryRow label="Final selling total" numeric total>₹1,00,000.00</SummaryRow>
                      </SummaryList>
                      <Timeline
                        label="Sample history"
                        showState
                        items={[
                          { id: '1', title: 'Documents received', meta: '11 Oct, 10:05 · Sample Desk', state: 'done' },
                          { id: '2', title: 'Application submitted', meta: 'Reference recorded', state: 'current' },
                          { id: '3', title: 'Decision from the authority', state: 'upcoming' },
                        ]}
                      />
                    </CardBody>
                  </Card>
                </div>
              </div>
            </Section>

            <Section id="g-empty" title="Empty and loading states">
              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardTitle level={3}>Empty</CardTitle>
                    <CardDescription>Nothing waiting</CardDescription>
                  </CardHeader>
                  <EmptyState
                    icon={Inbox}
                    title="No Deals need you right now"
                    description="New Deals from Bitrix appear here within a few minutes. You can also start one yourself."
                    action={
                      <Button variant="secondary">
                        <Plus aria-hidden="true" /> New Deal
                      </Button>
                    }
                  />
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle level={3}>Loading</CardTitle>
                    <CardDescription>Placeholder shapes</CardDescription>
                  </CardHeader>
                  <CardBody>
                    <LoadingRegion label="Loading Deals…">
                      <Skeleton className="h-5 w-2/3" />
                      <Skeleton className="w-full" />
                      <Skeleton className="w-5/6" />
                      <div className="flex gap-3 pt-2">
                        <Skeleton className="h-16 flex-1 rounded-card" />
                        <Skeleton className="h-16 flex-1 rounded-card" />
                      </div>
                    </LoadingRegion>
                  </CardBody>
                </Card>
              </div>
            </Section>
          </main>
        </div>
      </div>
    </GalleryProviders>
  );
}
