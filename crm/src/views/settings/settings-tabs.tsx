'use client';

import { usePathname } from 'next/navigation';
import { Tabs } from '@/components/ui/tabs';
import { currentSettingsTab, type SettingsTabVM } from '@/modules/settings/contracts';
import { SETTINGS_TAB_DESCRIPTION } from '@/modules/settings/text';

/*
 * The Settings tab bar (DA-17, DA-252): one link per category the person may
 * open, in DA-17 order. Links, not an ARIA tablist (each tab is its own page
 * at today's address, lead decision L1), so they work without script; the
 * open one carries aria-current="page" and is also named in words below the
 * bar (never colour alone). Look: shadcn Tabs 953 (the CRM link tabs).
 */
export function SettingsTabs({ tabs, currentPath }: { tabs: SettingsTabVM[]; /** Preview gallery only: the address to mark (else the browser's). */ currentPath?: string }) {
  const pathname = usePathname();
  const current = currentSettingsTab(tabs, currentPath ?? pathname);
  const open = tabs.find((t) => t.category === current);
  return (
    <div className="flex flex-col gap-2.5">
      <Tabs label="Settings sections" items={tabs.map((t) => ({ href: t.href, label: t.label, current: t.category === current }))} />
      {open ? (
        <p className="m-0 text-sm text-quiet" data-slot="settings-tab-line">
          <span className="font-semibold text-copy">{open.label}:</span> {SETTINGS_TAB_DESCRIPTION[open.category]}
        </p>
      ) : null}
    </div>
  );
}
