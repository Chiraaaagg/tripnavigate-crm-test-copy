import {
  accountsSection,
  accountsTabOf,
  type AccountsCounts,
  type AccountsSectionKey,
  type AccountsSectionViewer,
} from '@/views/accounts-desk/sections';
import { Tabs } from './tabs';

/*
 * D5: the tab strip under the header of every Accounts page. It reads the one
 * section list (src/views/accounts-desk/sections.ts) and shows only the tabs
 * this person may open, each an existing address, in the C5 pill look with
 * counts. A section with one visible tab shows no strip (nothing to switch).
 * Navigation only: every page still decides access on its own.
 */
export function SectionTabs({
  section,
  currentHref,
  viewer,
  counts = {},
  className = 'mb-4',
}: {
  section: AccountsSectionKey;
  /** The address of the page being shown (path, optionally with its query). */
  currentHref: string;
  /** The menu flags the page already has (the frame loads them for every page). */
  viewer: AccountsSectionViewer;
  /** Count per tab address; 'unknown' shows "count not known"; a missing address shows no badge. */
  counts?: AccountsCounts;
  className?: string;
}) {
  const s = accountsSection(section);
  const tabs = s.tabs.filter((t) => t.visible(viewer));
  if (tabs.length < 2) return null;
  const current = accountsTabOf(currentHref, [{ ...s, tabs }])?.tab.href;
  return (
    <Tabs
      variant="pill"
      label={`${s.label} sections`}
      className={className}
      items={tabs.map((t) => ({ href: t.href, label: t.label, current: t.href === current, count: counts[t.href] }))}
    />
  );
}
