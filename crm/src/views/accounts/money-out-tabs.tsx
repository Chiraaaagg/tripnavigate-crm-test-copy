import { SectionTabs } from '@/components/ui/section-tabs';
import type { AccountsCounts, AccountsSectionViewer } from '@/views/accounts-desk/sections';

/*
 * Kept apart from supplier-kit.tsx (R4 integration): the frozen Flight invoice
 * form imports supplier-kit.tsx, and the section strip would pull the menu
 * and the staff frame into the frozen forms' import closure.
 */

/**
 * Redesign R4 (D5): the Money out tab strip under the page header. Only the
 * tabs this person may open (the same flags as the menu); no strip when the
 * page passes no viewer (the Manager's Approvals page reuses these cards).
 * Counts only where the page already loads them. Navigation only.
 */
export function MoneyOutTabs({ viewer, currentHref, counts }: { viewer?: AccountsSectionViewer; currentHref: string; counts?: AccountsCounts }) {
  if (!viewer) return null;
  return <SectionTabs section="money-out" currentHref={currentHref} viewer={viewer} counts={counts} />;
}
