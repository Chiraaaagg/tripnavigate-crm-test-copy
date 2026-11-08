import type { ReactNode } from 'react';
import { PageHeader } from '@/components/ui/page-header';
import type { SettingsTabVM } from '@/modules/settings/contracts';
import { SETTINGS_TEXT } from '@/modules/settings/text';
import { SettingsTabs } from './settings-tabs';

/*
 * The Settings area (Direction A R6, DA-250 to DA-252): one page title
 * "Settings", the approval line once per page (DA-251, replaces the per-row
 * approval lines and the old Workflow banner), the tab bar of the categories
 * this person may open, then the page itself. Each page's own heading is a
 * section heading (h2). The tabs are convenience only: every page, command
 * and database policy still decides access on its own.
 */
export function SettingsFrame({ tabs, children, currentPath }: { tabs: SettingsTabVM[]; children: ReactNode; /** Preview gallery only. */ currentPath?: string }) {
  return (
    <div className="font-sans text-base text-copy" data-slot="settings-frame">
      <PageHeader title={SETTINGS_TEXT.title} description={tabs.length > 0 ? SETTINGS_TEXT.frameLine : undefined} className="mb-3" />
      {tabs.length > 0 ? (
        <div className="mb-6">
          <SettingsTabs tabs={tabs} currentPath={currentPath} />
        </div>
      ) : null}
      <div className="flex flex-col gap-5">{children}</div>
    </div>
  );
}

/** A section heading inside a Settings tab (the page's former h1). */
export function SettingsSectionHeading({ id, children, description }: { id?: string; children: ReactNode; description?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h2 id={id} className="m-0 text-xl leading-tight font-display tracking-heading text-ink">
        {children}
      </h2>
      {description ? <p className="m-0 text-copy">{description}</p> : null}
    </div>
  );
}
