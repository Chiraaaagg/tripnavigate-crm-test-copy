import { Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { Notice } from '@/components/ui/notice';
import { SwitchRow, switchRowDescribedBy } from '@/components/ui/switch-row';
import type { LastChangeVM, SettingKey } from '@/modules/settings/contracts';
import { switchReasonRule } from '@/modules/settings/reason';
import type { SettingRowModel, SettingsSectionModel, VisaPreviewModel } from '@/modules/settings/rows';
import { CHANGEABLE_SWITCH_KEYS, type ChangeableSwitchKey, type SwitchActionResult } from '@/modules/settings/switch';
import { SettingSwitchChange, type SettingSwitchActions } from './setting-switch-form';

export type { SettingSwitchActions } from './setting-switch-form';

/*
 * Settings rows, UX redesign R1 (C6 switch row, owner choice A: sean0205
 * Switch With Description 29860, row layout only). Each row: the plain switch
 * name, one line of what it does, the state in words with an icon (On, Off,
 * Not known), the last change (who, when), and on the right "Change", which
 * opens the one confirm dialog (C7). It is not a toggle. Who it affects, the
 * full last-change line and its reason sit behind "More". Not known never
 * offers a change and is never shown as Off: its Change is disabled with the
 * reason, as is a row this person may not change. A read-only row (set by
 * the CRM team) has no Change at all, only the line saying where it is. A
 * section the person may not read is not rendered. All rows of a section sit
 * in one card.
 */

const WHEN = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Kolkata' });

function whenText(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : `${WHEN.format(t)} IST`;
}

/** The short "Last change: who, when" of a row; undefined when there is no person or system change to name. */
export function lastOf(change: LastChangeVM): { who: string; when: string } | undefined {
  if (change.kind === 'person') return { who: change.byYou ? 'you' : change.byName, when: whenText(change.at) };
  if (change.kind === 'system') return { who: 'a system update', when: whenText(change.at) };
  return undefined;
}

const isChangeable = (key: SettingKey): key is ChangeableSwitchKey => (CHANGEABLE_SWITCH_KEYS as readonly string[]).includes(key);

export function settingRowId(row: Pick<SettingRowModel, 'key' | 'scope'>): string {
  return `setting-${row.key}${row.scope ? `-${row.scope.legalEntityId}-${row.scope.mode}` : ''}`;
}

/** The "More" fold of a row: who it affects, the full last-change line and its reason. */
function moreOf(row: SettingRowModel): ReactNode {
  return (
    <>
      <p className="m-0">Affects: {row.affects.toLowerCase() === 'every branch' ? 'every branch' : row.affects}.</p>
      <p className="m-0 mt-1" data-slot="setting-last-change">
        {row.lastChangeLine}
        {row.lastChangeReason ? <span className="block wrap-break-word">{row.lastChangeReason}</span> : null}
      </p>
    </>
  );
}

export interface SettingRowPreview {
  open?: boolean;
  reason?: string;
  result?: SwitchActionResult | null;
  visa?: VisaPreviewModel | null;
}

export function SettingRow({ row, actions, initial }: { row: SettingRowModel; actions?: SettingSwitchActions; /** Preview gallery only: the dialog open with a reason or a reply. */ initial?: SettingRowPreview }) {
  const id = settingRowId(row);
  const known = row.state === 'on' || row.state === 'off';
  const canPost = known && row.control.kind === 'switch' && row.control.canChange && !!row.review && !!actions && isChangeable(row.key);
  // Read-only rows (set by the CRM team) have no Change at all: the lock line says where it is changed.
  // Otherwise Not known first (DA-255), then "only a Super Admin": Change is shown disabled with the reason.
  const readOnly = row.control.kind === 'read_only';
  const disabledReason = row.control.kind === 'read_only' ? null : row.state === 'unknown' ? row.unknownText : canPost ? null : (row.control.blockedText ?? null);
  const effect = readOnly ? (
    <>
      {row.detail ? <span className="block">{row.detail}</span> : null}
      {row.state === 'unknown' && row.unknownText ? <span className="block">{row.unknownText}</span> : null}
      <span className="mt-1 flex items-start gap-1.5 text-quiet">
        <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        <span>{row.control.kind === 'read_only' ? row.control.text : null}</span>
      </span>
    </>
  ) : (
    row.detail || undefined
  );
  return (
    <li className="m-0 border-b border-line last:border-b-0" data-slot="setting-row" data-key={row.key} data-state={row.state}>
      <SwitchRow
        id={id}
        className="border-b-0"
        name={row.title}
        effect={effect}
        more={moreOf(row)}
        state={row.state}
        last={lastOf(row.lastChange)}
        disabledReason={disabledReason ?? undefined}
        change={
          canPost && known && isChangeable(row.key) ? (
            <SettingSwitchChange
              settingKey={row.key}
              title={row.title}
              state={row.state as 'on' | 'off'}
              review={row.review!}
              actions={actions!}
              reasonRule={switchReasonRule(row.key)}
              describedBy={switchRowDescribedBy(id)}
              initialOpen={initial?.open}
              initialReason={initial?.reason}
              initialResult={initial?.result}
              initialVisa={initial?.visa}
            />
          ) : null
        }
      />
    </li>
  );
}

/** The rows of a section in one card (a list; each row ends with a hairline). */
export function SettingRowsCard({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul className="m-0 list-none rounded-card border border-line bg-card p-0 shadow-card" aria-label={label}>
      {children}
    </ul>
  );
}

/**
 * One group of rows under a section heading (Features, Bitrix switches,
 * read-only rows). The section-level Not known or not-installed line (DA-255)
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
  extraRows,
  preview,
}: {
  id: string;
  title: string;
  description?: string;
  section: SettingsSectionModel;
  actions?: SettingSwitchActions;
  /** Rows shown elsewhere on the page (e.g. Bitrix names keeps its own card). */
  hideKeys?: SettingKey[];
  /** More rows in the same card (Features: the staff notices switch). */
  extraRows?: ReactNode;
  /** Preview gallery only: one row's dialog open. */
  preview?: { key: SettingKey } & SettingRowPreview;
}) {
  const rows = section.rows.filter((r) => !hideKeys.includes(r.key));
  if (rows.length === 0 && !section.sectionText && !extraRows) return null;
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
      {rows.length > 0 || extraRows ? (
        <SettingRowsCard label={title}>
          {rows.map((row) => (
            <SettingRow
              key={`${row.key}-${row.scope?.legalEntityId ?? ''}-${row.scope?.mode ?? ''}`}
              row={row}
              actions={actions}
              initial={preview && preview.key === row.key ? preview : undefined}
            />
          ))}
          {extraRows}
        </SettingRowsCard>
      ) : null}
    </section>
  );
}
