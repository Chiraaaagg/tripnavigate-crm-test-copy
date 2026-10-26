'use client';

import {
  Banknote,
  Briefcase,
  Building2,
  Circle,
  ClipboardCheck,
  ClipboardList,
  HandCoins,
  House,
  Inbox,
  KeyRound,
  Landmark,
  Plane,
  Settings,
  Stamp,
  FileSpreadsheet,
  FileText,
  Map as MapIcon,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useId } from 'react';
import { cn, focusRing } from '@/components/ui/cn';

/** Menu groups (Direction A, copy-catalogue §16.1): Work, then Accounts, then Settings. */
export type NavGroup = 'Work' | 'Accounts' | 'Settings';

export interface NavItem {
  href: string;
  label: string;
  group: NavGroup;
  /**
   * Batch 4: the item is also current on every address under this prefix
   * (the one "Settings" item: its href is the person's first Settings tab,
   * and it stays current on every /app/admin/* page).
   */
  activePrefix?: string;
}

/** One icon per section (decorative; the label is the accessible name). */
const ICONS: Record<string, LucideIcon> = {
  '/app': House,
  '/app/leads': Inbox,
  '/app/deals': Briefcase,
  '/app/quotations': FileText,
  '/app/itineraries': MapIcon,
  '/app/purchase': ClipboardList,
  '/app/purchase/suppliers': Building2,
  '/app/flight': Plane,
  '/app/visa': Stamp,
  '/app/accounts': ClipboardCheck,
  '/app/accounts/claims': HandCoins,
  '/app/accounts/expenses': FileSpreadsheet,
  '/app/accounts/cash': Banknote,
  '/app/accounts/destinations': Landmark,
};

/** Icons keyed by the item's activePrefix (the one Settings item: its href is the person's first Settings tab). */
const PREFIX_ICONS: Record<string, LucideIcon> = {
  '/app/admin': Settings,
};

/** The link that marks the current page: the longest matching address (so /app/purchase/suppliers marks "Suppliers" only). */
export function currentHref(hrefs: string[], path: string | null | undefined): string | undefined {
  const matches = (href: string) => (href === '/app' ? path === '/app' : !!path && (path === href || path.startsWith(`${href}/`)));
  return hrefs.filter(matches).sort((x, y) => y.length - x.length)[0];
}

/**
 * The current item's href: currentHref over the hrefs, plus each item's
 * activePrefix. Longest matching address wins, so an exact item beats a
 * shorter prefix.
 */
export function currentNavHref(items: Array<Pick<NavItem, 'href' | 'activePrefix'>>, path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  const matches = (prefix: string) => (prefix === '/app' ? path === '/app' : path === prefix || path.startsWith(`${prefix}/`));
  let best: { href: string; length: number } | undefined;
  for (const item of items) {
    for (const prefix of item.activePrefix ? [item.href, item.activePrefix] : [item.href]) {
      if (matches(prefix) && (!best || prefix.length > best.length)) best = { href: item.href, length: prefix.length };
    }
  }
  return best?.href;
}

/**
 * The grouped section links of the staff frame (desktop sidebar and the phone
 * Menu sheet). Look adapted from the shadcn Sidebar (21st.dev id 1627, MIT):
 * SidebarGroup / SidebarGroupLabel / SidebarMenu / SidebarMenuButton class
 * strings, mapped to the CRM tokens. Server-rendered links, so the menu works
 * without script; the current page carries aria-current="page" and a heavier
 * weight as well as the tint (never colour alone).
 */
export function NavLinks({ items, currentPath }: { items: NavItem[]; currentPath?: string }) {
  const pathname = usePathname();
  const current = currentNavHref(items, currentPath ?? pathname);
  const idBase = useId();
  const groups = items.reduce<Array<{ label: NavGroup; items: NavItem[] }>>((out, item) => {
    const last = out[out.length - 1];
    if (last && last.label === item.group) last.items.push(item);
    else out.push({ label: item.group, items: [item] });
    return out;
  }, []);
  return (
    <div className="flex flex-col gap-1 font-sans">
      {groups.map((group) => {
        const labelId = `${idBase}-${group.label}`;
        return (
          <div key={group.label} role="group" aria-labelledby={labelId} className="relative flex w-full min-w-0 flex-col py-1">
            <p id={labelId} className="m-0 flex h-8 shrink-0 items-center px-2.5 text-xs font-semibold text-quiet">
              {group.label}
            </p>
            <ul className="m-0 flex w-full min-w-0 list-none flex-col gap-0.5 p-0">
              {group.items.map((item) => {
                const isCurrent = item.href === current;
                const Icon = (item.activePrefix ? PREFIX_ICONS[item.activePrefix] : undefined) ?? ICONS[item.href] ?? Circle;
                return (
                  <li key={item.href} className="relative m-0">
                    <Link
                      href={item.href}
                      aria-current={isCurrent ? 'page' : undefined}
                      className={cn(
                        'flex min-h-9 w-full items-center gap-2.5 overflow-hidden rounded-control px-2.5 py-1.5 text-left text-base font-medium text-copy no-underline',
                        'transition-[color,background-color] duration-(--ui-duration-quick) motion-reduce:transition-none',
                        'hover:bg-wash hover:text-ink',
                        'aria-[current=page]:bg-brand-tint aria-[current=page]:font-semibold aria-[current=page]:text-brand-deep',
                        focusRing,
                        'focus-visible:outline-offset-0',
                      )}
                    >
                      <Icon aria-hidden="true" className={cn('size-4 shrink-0', isCurrent ? 'text-brand' : 'text-quiet')} />
                      <span className="min-w-0 flex-1">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/**
 * "My access" in the account panel (plan T5: it left the menu; /app/access
 * still opens). Marked as the current page while the person is on it.
 */
export function AccountAccessLink({ currentPath }: { currentPath?: string }) {
  const pathname = usePathname();
  const path = currentPath ?? pathname;
  const isCurrent = path === '/app/access' || !!path?.startsWith('/app/access/');
  return (
    <Link
      href="/app/access"
      aria-current={isCurrent ? 'page' : undefined}
      className={cn(
        'flex min-h-9 w-full items-center gap-2.5 rounded-control px-2.5 py-1.5 font-sans text-base font-medium text-copy no-underline',
        'hover:bg-wash hover:text-ink',
        'aria-[current=page]:bg-brand-tint aria-[current=page]:font-semibold aria-[current=page]:text-brand-deep',
        focusRing,
        'focus-visible:outline-offset-0',
      )}
    >
      <KeyRound aria-hidden="true" className="size-4 shrink-0 text-quiet" />
      My access
    </Link>
  );
}
