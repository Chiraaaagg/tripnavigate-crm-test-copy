import { History, Lock, Users } from 'lucide-react';
import { Notice } from '@/components/ui/notice';
import type { SettingKey } from '@/modules/settings/contracts';
import type { SettingRowModel, SettingsSectionModel } from '@/modules/settings/rows';
import { SettingStateBadge } from './setting-state';
import { SettingSwitchForm, type SettingSwitchActions } from './setting-switch-form';

export type { SettingSwitchActions } from './setting-switch-form';

/*
 * Settings rows (pattern P-SETTING, catalog gap G5; copy DA-253 to DA-258).
 * Each row: the plain switch name, its state in words with an icon, what it
 * does, who it affects, when it last changed and by whom (with the reason),
 * and then either the change flow (Change → choose and reason → review →
 * confirm, one HandForm) or a read-only line. Unknown never offers a form and
 * is never shown as Off; a section the person may not read is not rendered.
 */

export function SettingRow({ row, actions, headingLevel = 3 }: { row: SettingRowModel; actions?: SettingSwitchActions; headingLevel?: 3 | 4 }) {
  const Heading = headingLevel === 3 ? 'h3' : 'h4';
  const headingId = `setting-${row.key}${row.scope ? `-${row.scope.legalEntityId}-${row.scope.mode}` : ''}`;
  return (
    <li className="m-0 flex flex-col gap-3 rounded-control border border-line bg-card px-4 py-3.5" data-slot="setting-row" data-key={row.key}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          <Heading id={headingId} className="m-0 text-base font-semibold text-ink">
            {row.title}
          </Heading>
          {row.detail ? <p className="m-0 mt-0.5 text-sm text-copy">{row.detail}</p> : null}
        </div>
        <SettingStateBadge state={row.state} label={`${row.title}, current state`} />
      </div>
      <div className="flex flex-col gap-1 text-sm text-quiet">
        <p className="m-0 flex items-start gap-1.5">
          <Users aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-faint" />
          <span>Affects: {row.affects.toLowerCase() === 'every branch' ? 'every branch' : row.affects}</span>
        </p>
        <p className="m-0 flex items-start gap-1.5" data-slot="setting-last-change">
          <History aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-faint" />
          <span className="min-w-0">
            {row.lastChangeLine}
            {row.lastChangeReason ? <span className="block wrap-break-word text-copy">{row.lastChangeReason}</span> : null}
          </span>
        </p>
      </div>
      {row.unknownText ? (
        <Notice tone="warning" role="status">
          <p>{row.unknownText}</p>
        </Notice>
      ) : null}
      {row.control.kind === 'read_only' ? (
        <p className="m-0 flex items-start gap-1.5 text-sm text-quiet">
          <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-faint" />
          <span>{row.control.text}</span>
        </p>
      ) : row.control.canChange && row.review && actions && (row.state === 'on' || row.state === 'off') ? (
        <SettingSwitchForm settingKey={row.key} title={row.title} state={row.state} review={row.review} actions={actions} />
      ) : row.control.blockedText ? (
        <p className="m-0 flex items-start gap-1.5 text-sm text-quiet">
          <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-faint" />
          <span>{row.control.blockedText}</span>
        </p>
      ) : null}
    </li>
  );
}

/**
 * One group of rows under a section heading (Features, Bitrix switches,
 * read-only rows). The section-level Unknown or not-installed line (DA-255)
 * sits above the rows; with no rows and no line nothing is rendered (a
 * section this person may not read is not shown at all).
 */
export function SettingsSectionView({
  id,
  title,
  description,
  section,
  actions,
  hideKeys = [],
}: {
  id: string;
  title: string;
  description?: string;
  section: SettingsSectionModel;
  actions?: SettingSwitchActions;
  /** Rows shown elsewhere on the page (e.g. Bitrix names keeps its own card). */
  hideKeys?: SettingKey[];
}) {
  const rows = section.rows.filter((r) => !hideKeys.includes(r.key));
  if (rows.length === 0 && !section.sectionText) return null;
  const headingId = `${id}-heading`;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3" data-slot="settings-section" id={id}>
      <div className="flex flex-col gap-1">
        <h3 id={headingId} className="m-0 text-lg font-semibold text-ink">
          {title}
        </h3>
        {description ? <p className="m-0 text-copy">{description}</p> : null}
      </div>
      {section.sectionText ? (
        <Notice tone="warning" role="status">
          <p>{section.sectionText}</p>
        </Notice>
      ) : null}
      {rows.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-3 p-0" aria-labelledby={headingId}>
          {rows.map((row) => (
            <SettingRow key={`${row.key}-${row.scope?.legalEntityId ?? ''}-${row.scope?.mode ?? ''}`} row={row} actions={actions} headingLevel={4} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
