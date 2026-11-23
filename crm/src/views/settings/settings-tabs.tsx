'use client';

import {
  Activity,
  Building2,
  Calculator,
  FileSpreadsheet,
  Landmark,
  ListChecks,
  MessageSquare,
  RefreshCw,
  Settings,
  Users,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { buttonVariants, Button } from '@/components/ui/button';
import { cn, focusRing } from '@/components/ui/cn';
import { Label } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/page-header';
import { Select } from '@/components/ui/select';
import {
  currentSettingsTab,
  SETTINGS_AREA_LINE,
  SETTINGS_LAST_AREA_KEY,
  SETTINGS_PATH,
  SETTINGS_PREFIX,
  type SettingsCategory,
  type SettingsTabVM,
} from '@/modules/settings/contracts';
import { SETTINGS_TEXT } from '@/modules/settings/text';

/*
 * The Settings area chrome (R1, design plan 1.4; audit N7, S1, S2, X1):
 *
 *   - an area list on the left on wide screens (links, aria-current="page" on
 *     the open area, an icon beside every name) and a "Settings area" select
 *     with an "Open" button on phones and at 200% zoom (never navigates on
 *     change, so arrow keys only move the choice);
 *   - one heading per area (the area name, a small "Settings" label above it)
 *     and one muted line;
 *   - the last area opened, kept in this browser only, for the Overview's
 *     "Back to" link.
 *
 * The list keeps the accessible name "Settings sections" that the menu and the
 * other screens' tests already use. Links, not an ARIA tablist: each area is
 * its own page at today's address (lead decision L1), so they work without
 * script. Look: the approved prototype (81-settings.js frame), the CRM link
 * style and originui Tabs 425 (vertical list), pattern only.
 * Convenience only: every page, command and database policy still decides.
 */

const AREA_ICON: Record<SettingsCategory, LucideIcon> = {
  overview: Settings,
  people: Users,
  company: Building2,
  money: Landmark,
  accounts: Calculator,
  bitrix: RefreshCw,
  features: ListChecks,
  messages: MessageSquare,
  imports: FileSpreadsheet,
  health: Activity,
};

/** The area's icon (decorative: the name is always in words beside it). */
export function AreaIcon({ category, className }: { category: SettingsCategory; className?: string }) {
  const Icon = AREA_ICON[category];
  return <Icon aria-hidden="true" className={cn('size-4 shrink-0', className)} />;
}

function rememberArea(category: SettingsCategory, href: string) {
  try {
    window.localStorage.setItem(SETTINGS_LAST_AREA_KEY, JSON.stringify({ category, href }));
  } catch {
    // Private window or blocked storage: the Overview simply offers no "Back to" link.
  }
}

function readLastArea(): { category: string; href: string } | null {
  try {
    const raw = window.localStorage.getItem(SETTINGS_LAST_AREA_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object') return null;
    const { category, href } = value as { category?: unknown; href?: unknown };
    return typeof category === 'string' && typeof href === 'string' ? { category, href } : null;
  } catch {
    return null;
  }
}

function AreaList({ tabs, current }: { tabs: SettingsTabVM[]; current: SettingsCategory | undefined }) {
  return (
    <nav aria-label="Settings sections" className="hidden lg:block" data-slot="settings-areas">
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {tabs.map((t) => {
          const isCurrent = t.category === current;
          return (
            <li key={t.category} className="m-0">
              <Link
                href={t.href}
                aria-current={isCurrent ? 'page' : undefined}
                className={cn(
                  'flex min-h-9 w-full items-center gap-2.5 rounded-control px-2.5 py-1.5 text-base font-medium text-copy no-underline hover:bg-wash hover:text-ink',
                  'aria-[current=page]:bg-brand-tint aria-[current=page]:font-semibold aria-[current=page]:text-brand-deep',
                  focusRing,
                )}
              >
                <AreaIcon category={t.category} className={isCurrent ? 'text-brand' : 'text-quiet'} />
                <span className="min-w-0 flex-1">{t.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * Phones and 200% zoom: a select of the areas and an "Open" button. Without
 * script the form asks the Overview page, which sends the person to the
 * chosen area when it is one of theirs.
 */
function AreaPicker({ tabs, current }: { tabs: SettingsTabVM[]; current: SettingsCategory | undefined }) {
  const router = useRouter();
  const id = useId();
  const currentHref = tabs.find((t) => t.category === current)?.href ?? '';
  return (
    <form
      action={SETTINGS_PATH.overview}
      method="get"
      className="flex flex-wrap items-end gap-2 lg:hidden"
      data-slot="settings-area-picker"
      onSubmit={(event) => {
        const value = new FormData(event.currentTarget).get('area');
        if (typeof value !== 'string' || !tabs.some((t) => t.href === value)) return;
        event.preventDefault();
        router.push(value);
      }}
    >
      <div className="flex min-w-0 flex-1 basis-56 flex-col gap-1.5">
        <Label htmlFor={`${id}-area`}>Settings area</Label>
        <Select id={`${id}-area`} name="area" defaultValue={currentHref} key={currentHref}>
          {currentHref ? null : (
            <option value="" disabled>
              Choose an area
            </option>
          )}
          {tabs.map((t) => (
            <option key={t.category} value={t.href}>
              {t.label}
            </option>
          ))}
        </Select>
      </div>
      <Button type="submit">Open</Button>
    </form>
  );
}

/**
 * The frame around every Settings page: area list, area heading and line,
 * then the page. With no area for this person (someone without a Settings
 * right) it shows only the "Settings" heading and the page's own refusal.
 */
export function SettingsAreas({ tabs, currentPath, children }: { tabs: SettingsTabVM[]; /** Preview gallery only: the address to mark (else the browser's). */ currentPath?: string; children: ReactNode }) {
  const pathname = usePathname();
  const path = currentPath ?? pathname;
  const current = currentSettingsTab(tabs, path);
  const open = tabs.find((t) => t.category === current);

  useEffect(() => {
    if (!open || open.category === 'overview' || !path?.startsWith(SETTINGS_PREFIX)) return;
    rememberArea(open.category, path.split(/[?#]/)[0]!);
  }, [open, path]);

  const header = open ? (
    <PageHeader eyebrow={SETTINGS_TEXT.title} title={open.label} description={SETTINGS_AREA_LINE[open.category]} className="mb-0" />
  ) : (
    <PageHeader title={SETTINGS_TEXT.title} className="mb-0" />
  );

  if (tabs.length === 0) {
    return (
      <div className="flex flex-col gap-5 font-sans text-base text-copy" data-slot="settings-frame">
        {header}
        {children}
      </div>
    );
  }
  return (
    <div className="grid gap-6 font-sans text-base text-copy lg:grid-cols-[14rem_minmax(0,1fr)]" data-slot="settings-frame">
      <AreaList tabs={tabs} current={current} />
      <div className="flex min-w-0 flex-col gap-5">
        <AreaPicker tabs={tabs} current={current} />
        {header}
        {children}
      </div>
    </div>
  );
}

/**
 * Overview: "Back to <area>" for the last area this browser opened, when it
 * is still one of this person's areas. Shown after the page loads (the value
 * lives in this browser only); nothing when there is none.
 */
export function LastAreaLink({ tabs }: { tabs: SettingsTabVM[] }) {
  const [last, setLast] = useState<{ tab: SettingsTabVM; href: string } | null>(null);
  useEffect(() => {
    const stored = readLastArea();
    if (!stored || !stored.href.startsWith(`${SETTINGS_PREFIX}/`)) return;
    const category = currentSettingsTab(tabs, stored.href);
    const tab = tabs.find((t) => t.category === category && t.category === stored.category);
    // Reading this browser's storage can only happen after the page loads.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (tab && tab.category !== 'overview') setLast({ tab, href: stored.href });
  }, [tabs]);
  if (!last) return null;
  return (
    <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-copy" data-slot="settings-last-area">
      <span>You were last in {last.tab.label}.</span>
      <Link href={last.href} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
        <AreaIcon category={last.tab.category} />
        Back to {last.tab.label}
      </Link>
    </p>
  );
}
