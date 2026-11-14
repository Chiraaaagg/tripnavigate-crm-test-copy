import { FileText, Landmark, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { StatusBadge, type StatusTone } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/empty-state';
import { Tabs } from '@/components/ui/tabs';
import { formatPaise } from '@/modules/deals/dto';
import type { BankDetailsSummary } from '@/modules/supplier-money/contracts';
import { formatDateOnly } from '../booking-views';
import { formatIst } from '../deal-labels';

/*
 * Server-safe building blocks shared by the Accounts supplier pages and the
 * Manager's Approvals page (Purchase build, Track C): one card per item with
 * its status (icon + words), a facts list, file links and link tabs. Built
 * from the live kit (Card, StatusBadge, Tabs, EmptyState); the 21st.dev
 * "Progress List" idea (one row per item, clear state, one decision) only.
 */

export const inr = (paise: string) => formatPaise(paise);
export const dateText = (iso: string | null | undefined) => (iso ? formatDateOnly(iso) : 'Not set');
export const whenText = (iso: string) => formatIst(iso);

export function byText(name: string | null | undefined): string {
  return name ? `by ${name}` : 'by a colleague';
}

export function Status({ tone, icon, label, children }: { tone: StatusTone; icon?: LucideIcon; label?: string; children: ReactNode }) {
  return (
    <StatusBadge tone={tone} icon={icon} wrap>
      {label ? <span className="sr-only">{label}: </span> : null}
      {children}
    </StatusBadge>
  );
}

/** Link tabs (?tab=) with counts from rows already on the page. */
export function ListTabs<T extends string>({ label, basePath, current, tabs, defaultTab }: { label: string; basePath: string; current: T; defaultTab: T; tabs: Array<{ key: T; label: string; count?: number }> }) {
  return (
    <Tabs
      label={label}
      className="mb-4"
      items={tabs.map((t) => ({ href: t.key === defaultTab ? basePath : `${basePath}?tab=${t.key}`, label: t.label, current: t.key === current, count: t.count }))}
    />
  );
}

export function ItemList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ol className="m-0 flex list-none flex-col gap-4 p-0" aria-label={label}>
      {children}
    </ol>
  );
}

/** One item: eyebrow (Deal · branch), title, status badges, then body. */
export function ItemCard({ id, eyebrow, title, status, children, aside, headingLevel = 2 }: { id: string; eyebrow: ReactNode; title: ReactNode; status: ReactNode; children: ReactNode; aside?: ReactNode; headingLevel?: 2 | 3 }) {
  const Heading = `h${headingLevel}` as const;
  return (
    <li className="m-0">
      <Card>
        <article aria-labelledby={id} className="flex flex-col gap-3 px-4.5 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="m-0 text-sm font-medium text-quiet">{eyebrow}</p>
              <Heading id={id} className="m-0 text-lg leading-6 font-semibold wrap-anywhere text-ink">
                {title}
              </Heading>
              <div className="mt-2.5 flex flex-wrap items-center gap-2">{status}</div>
            </div>
            {aside ? <div className="shrink-0 text-right max-sm:text-left">{aside}</div> : null}
          </div>
          {children}
        </article>
      </Card>
    </li>
  );
}

/** Amount shown in the card corner: label above, figure below. */
export function AmountAside({ label, paise, note }: { label: string; paise: string; note?: ReactNode }) {
  return (
    <>
      <p className="m-0 text-sm text-quiet">{label}</p>
      <p className="m-0 text-xl font-semibold text-ink tabular-nums">{inr(paise)}</p>
      {note ? <p className="m-0 text-sm text-quiet">{note}</p> : null}
    </>
  );
}

export function Facts({ rows }: { rows: Array<[string, ReactNode] | null | false> }) {
  const list = rows.filter((r): r is [string, ReactNode] => !!r);
  return (
    <dl className="m-0 grid grid-cols-1 gap-x-4 gap-y-1.5 text-base sm:grid-cols-[minmax(8rem,12rem)_1fr]">
      {list.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-sm font-medium text-quiet">{k}</dt>
          <dd className="m-0 min-w-0 wrap-break-word text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function FileLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} rel="noopener" className={cn('inline-flex items-center gap-1.5 rounded-chip font-medium wrap-anywhere text-brand-strong underline underline-offset-4 hover:text-brand-deep', focusRing)}>
      <FileText aria-hidden="true" className="size-4 shrink-0" />
      {children}
    </a>
  );
}

/** Supplier bank details: holder, bank, IFSC and only the last 4 digits. */
export function BankLine({ bank }: { bank: BankDetailsSummary | null }) {
  if (!bank) return <span className="text-quiet">No bank details recorded</span>;
  return (
    <span className="flex max-w-full min-w-0 items-start gap-2">
      <Landmark aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-faint" />
      <span className="min-w-0 wrap-anywhere">
        {bank.accountHolder} · {bank.bankName} · {bank.ifsc} ·{' '}
        <span className="sr-only">account ending </span>
          <span className="tabular-nums">
          <span aria-hidden="true">•••• </span>
          {bank.accountLast4}
        </span>{' '}
        · revision {bank.revisionNo} · {bank.status === 'approved' ? 'approved by the Manager' : 'not approved yet'}
      </span>
    </span>
  );
}

export function ListEmpty({ icon, title, description }: { icon: LucideIcon; title: string; description: string }) {
  return (
    <Card role="status">
      <EmptyState icon={icon} headingLevel={2} title={title} description={description} />
    </Card>
  );
}

export function DecisionPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2 rounded-control border border-line bg-canvas px-4 py-3">
      <p className="m-0 text-base font-semibold text-ink">{title}</p>
      {children}
    </section>
  );
}

/** Today's date in India (YYYY-MM-DD): the latest "Paid on" a payment may carry. */
export function todayInIndia(now: Date = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}
