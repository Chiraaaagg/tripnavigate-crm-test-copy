import type { ReactNode } from 'react';
import type { SettingsTabVM } from '@/modules/settings/contracts';
import { SettingsAreas } from './settings-tabs';

/*
 * The Settings area (R1, design plan 1.4; replaces the Batch 4 tab bar): the
 * area list on the left (a select on phones), one heading per area (the area
 * name) with one muted line, then the page itself. The approval line now sits
 * on the Overview landing and in each change dialog. Each page's own headings
 * are section headings (h2). The list is convenience only: every page,
 * command and database policy still decides access on its own.
 */
export function SettingsFrame({ tabs, children, currentPath }: { tabs: SettingsTabVM[]; children: ReactNode; /** Preview gallery only. */ currentPath?: string }) {
  return (
    <SettingsAreas tabs={tabs} currentPath={currentPath}>
      <div className="flex min-w-0 flex-col gap-5">{children}</div>
    </SettingsAreas>
  );
}

/** A section heading inside a Settings area (the page's former h1). */
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
