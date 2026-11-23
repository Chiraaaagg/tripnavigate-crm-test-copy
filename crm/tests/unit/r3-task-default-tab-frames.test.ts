import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement, type FunctionComponent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PurchaseTaskView } from '@/modules/fulfilment/contracts';
import { TASK_TABS, tabHref, type TaskTab } from '@/modules/settings/contracts';
import { defaultTaskTab, taskTabFor } from '@/views/department/task-default-tab';
import { TaskTabsNav } from '@/views/department/task-frame';
import { PurchaseTaskPage } from '@/views/purchase-views';

/**
 * R3 integration (D6 with the task page frames): the holder opens on Work, so
 * the tab links must name `?tab=details` for Details and keep the bare address
 * for Work. Otherwise the Details link would open Work again and the holder
 * could never reach Details. Every `?tab=` value keeps opening its own tab.
 */

const render = <P extends object>(c: FunctionComponent<P>, props: P) => renderToStaticMarkup(createElement(c as FunctionComponent<P>, props));
const views = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/views');

/** href of each link inside the "Task sections" navigation, by its visible label. */
function tabLinks(html: string): Record<string, string> {
  const nav = html.split('aria-label="Task sections"')[1]?.split('</nav>')[0] ?? '';
  const out: Record<string, string> = {};
  for (const m of nav.matchAll(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g)) out[m[2]!.replace(/<[^>]+>/g, '').trim()] = m[1]!.replace(/&amp;/g, '&');
  return out;
}

const BASE = '/app/purchase/f0000000-0000-4000-8000-000000000001';

function task(over: Partial<PurchaseTaskView> = {}): PurchaseTaskView {
  return {
    taskId: 'f0000000-0000-4000-8000-000000000001',
    dealReference: 'SYN-DEL-001',
    serviceType: 'hotel',
    itemTitle: 'Synthetic Lakeside Hotel, Udaipur',
    facts: { type: 'hotel', facts: { hotelName: 'Synthetic Lakeside Hotel', city: 'Udaipur', checkIn: '2026-11-14', checkOut: '2026-11-17', rooms: 1, adults: 2, children: 0 } },
    hotelName: 'Synthetic Lakeside Hotel',
    city: 'Udaipur',
    checkIn: '2026-11-14',
    checkOut: '2026-11-17',
    nights: 3,
    rooms: 1,
    travellers: { adults: 2, children: 0 },
    purchaseBudgetPaise: '4500000',
    status: 'in_progress',
    assigneeName: 'Synthetic Purchase Jodhpur',
    assignedToYou: true,
    branchName: 'Delhi',
    createdAt: '2026-10-02T07:05:00Z',
    supplierConfirmedAt: null,
    roomType: 'Deluxe',
    mealPlan: 'Breakfast',
    inclusions: null,
    specialRequests: null,
    confirmedAt: '2026-10-02T07:05:00Z',
    confirmedByName: 'Synthetic Sales Delhi A',
    versionNo: 1,
    canClaim: false,
    ...over,
  } as PurchaseTaskView;
}

describe('D6 default tab in the task page frames', () => {
  it('the holder: Work keeps the bare address, Details gets ?tab=details (TaskTabsNav)', () => {
    const tabs = [...TASK_TABS];
    const current = taskTabFor(undefined, tabs, true);
    expect(current).toBe('work');
    const links = tabLinks(render(TaskTabsNav, { basePath: BASE, tabs: { tabs, current }, defaultTab: defaultTaskTab(tabs, true) }));
    expect(links.Work).toBe(BASE);
    expect(links.Details).toBe(`${BASE}?tab=details`);
    expect(links.Files).toBe(`${BASE}?tab=files`);
    // The Details link opens Details for the holder, not Work again.
    expect(taskTabFor('details', tabs, true)).toBe('details');
  });

  it('a reader (nobody holds it, or someone else does): unchanged links, Details is the bare address', () => {
    const tabs = [...TASK_TABS];
    const links = tabLinks(render(TaskTabsNav, { basePath: BASE, tabs: { tabs, current: 'details' }, defaultTab: defaultTaskTab(tabs, false) }));
    expect(links.Details).toBe(BASE);
    expect(links.Work).toBe(`${BASE}?tab=work`);
  });

  it('every ?tab= value opens its own tab for the holder and for a reader; a bad value falls back to the default', () => {
    for (const tab of TASK_TABS) {
      expect(taskTabFor(tab, TASK_TABS, true)).toBe(tab);
      expect(taskTabFor(tab, TASK_TABS, false)).toBe(tab);
      // The link each frame prints opens that same tab again.
      for (const holds of [true, false]) {
        const href = tabHref(BASE, tab, defaultTaskTab(TASK_TABS, holds));
        const raw = new URL(href, 'https://crm.invalid').searchParams.get('tab') ?? undefined;
        expect(taskTabFor(raw, TASK_TABS, holds), `${tab} (${holds ? 'holder' : 'reader'})`).toBe(tab);
      }
    }
    expect(taskTabFor('money', TASK_TABS, true)).toBe('work');
    expect(taskTabFor('money', TASK_TABS, false)).toBe('details');
  });

  it('Purchase task page: the holder on Details can go back to Work, and the "Next:" link opens Work at the control', () => {
    const tabs = [...TASK_TABS] as TaskTab[];
    const html = render(PurchaseTaskPage, { task: task(), tabs: { tabs, current: 'details' }, defaultTab: defaultTaskTab(tabs, true) });
    const links = tabLinks(html);
    expect(links.Work).toBe(BASE);
    expect(links.Details).toBe(`${BASE}?tab=details`);
    // O6: from Details the header button opens Work (the holder's bare address) at the confirmation control.
    expect(html).toContain(`href="${BASE}#purchase-next-confirmation"`);
  });

  it('Flight and Visa workspaces pass the D6 default tab to the shared tab bar', () => {
    for (const file of ['flight/workspace.tsx', 'visa/workspace.tsx']) {
      const src = readFileSync(resolve(views, file), 'utf8');
      expect(src, file).toMatch(/<TaskTabsNav basePath=\{base\} tabs=\{tabs\} defaultTab=\{defaultTaskTab\(tabs\.tabs, ws\.assignee\.isYou\)\}/);
      // The old hard-coded default ('details') is gone from the tab links.
      expect(src, file).not.toMatch(/tabHref\(base, tab, 'details'\)/);
    }
  });
});
