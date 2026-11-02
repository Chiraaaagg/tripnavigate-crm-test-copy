import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DealProgress, DealServicesView, IntakeChecklist, ServiceFacts, ServiceItemView } from '@/modules/fulfilment/contracts';
import { FIELD } from '@/modules/fulfilment/forms';
import { DealServicesCard, DealServicesUnavailable } from '@/views/deal-services-view';
import {
  checklistItemText,
  confirmDialogLines,
  confirmSuccessText,
  factProblems,
  factsToSegments,
  factsToValues,
  FACT_FIELDS,
  intakeStage,
  paiseToRupees,
  plannedTaskCount,
  problemsFromFields,
  splitChecklist,
  travellerProblems,
  travellerProblemsFromFields,
  travellersNeeded,
} from '@/views/intake-fields';
import { IntakeDisabledView, IntakeLoading, IntakeNotAvailableView } from '@/views/intake-views';
import {
  countServiceTypes,
  factsLines,
  factsSummary,
  ProgressPill,
  serviceNextHref,
  serviceNextLinkText,
  serviceOwnerText,
  serviceStateInfo,
  ServiceStatePill,
  ServiceTypePill,
} from '@/views/service-labels';

/**
 * B1 pure view helpers and leaf renders (service labels, intake field
 * helpers, the Deal page services card). No database, no React effects.
 */

const views = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/views');

const hotel: ServiceFacts = {
  type: 'hotel',
  facts: { hotelName: 'Synthetic Reef Resort', city: 'Havelock', checkIn: '2026-11-14', checkOut: '2026-11-18', rooms: 1, adults: 2, children: 1 },
};
const flight: ServiceFacts = {
  type: 'flight',
  facts: { segments: [{ from: 'DEL', to: 'IXZ', date: '2026-11-14' }, { from: 'IXZ', to: 'DEL', date: '2026-11-20' }], passengers: 2, cabin: 'Economy' },
};
const transfer: ServiceFacts = { type: 'transfer', facts: { route: 'Airport to jetty', date: '2026-11-14', vehicleType: 'Sedan', passengers: 3 } };
const activity: ServiceFacts = { type: 'activity', facts: { name: 'Synthetic dive', city: 'Havelock', date: '2026-11-16', participants: 4 } };

function item(extra: Partial<ServiceItemView> = {}): ServiceItemView {
  return {
    itemId: 'a1000000-0000-4000-8000-000000000001',
    itemNo: 1,
    serviceType: 'hotel',
    department: 'purchase',
    state: 'planned',
    title: 'Synthetic Reef Resort, Havelock',
    facts: hotel,
    purchaseBudgetPaise: '6000000',
    factsHash: '1'.repeat(64),
    task: null,
    nextStep: 'confirm_version',
    ...extra,
  };
}

describe('service labels', () => {
  it('folds repeated service types into counts, in item order', () => {
    expect(countServiceTypes(['hotel', 'transfer', 'hotel', 'flight'])).toEqual([
      { type: 'hotel', count: 2 },
      { type: 'transfer', count: 1 },
      { type: 'flight', count: 1 },
    ]);
  });

  it('state words come from the department (Purchase vs Flight), never colour alone', () => {
    expect(serviceStateInfo(item()).label).toBe('Planned · no task yet');
    const taken = item({ state: 'active', task: { taskId: 't', status: 'in_progress', assigneeName: 'A', assignedToYou: false, supplierConfirmedAt: null }, department: 'flight', serviceType: 'flight' });
    expect(serviceStateInfo(taken).label).toBe('In progress · ticket not recorded in the CRM');
    const purchaseTaken = { ...taken, department: 'purchase' as const };
    expect(serviceStateInfo(purchaseTaken).label).toBe('In progress · not booked yet');
    const html = renderToStaticMarkup(createElement(ServiceStatePill, { item: taken }));
    expect(html).toContain('<svg');
    expect(html).toContain('Service status: ');
    expect(html).toMatch(/data-tone="info"/);
  });

  it('DA-287: Visa and passport items use the Visa desk words (never the Purchase or Flight ones); completed has the success look', () => {
    const visa = (status: 'not_started' | 'in_progress' | 'completed') =>
      item({ state: 'active', department: 'visa', serviceType: 'visa', task: { taskId: 'v', status, assigneeName: null, assignedToYou: false, supplierConfirmedAt: null } });
    expect(serviceStateInfo(visa('not_started')).label).toBe('Waiting to be taken');
    expect(serviceStateInfo(visa('in_progress')).label).toBe('In progress');
    expect(serviceStateInfo(visa('completed'))).toMatchObject({ label: 'Completed', tone: 'success' });
    for (const status of ['not_started', 'in_progress', 'completed'] as const) expect(serviceStateInfo(visa(status)).label).not.toMatch(/hotel|ticket/);
  });

  it('owner text and next-step links follow the task and department', () => {
    expect(serviceOwnerText(item())).toBe('Purchase (after confirmation)');
    const mine = item({ state: 'active', task: { taskId: 'f1', status: 'not_started', assigneeName: null, assignedToYou: true, supplierConfirmedAt: null } });
    expect(serviceOwnerText(mine)).toBe('You');
    expect(serviceOwnerText({ ...mine, task: { ...mine.task!, assignedToYou: false } })).toBe('Purchase · not taken yet');
    expect(serviceNextHref(item(), 'd1')).toBe('/app/deals/d1/intake');
    expect(serviceNextLinkText(item())).toBe('Open intake');
    expect(serviceNextHref(mine, 'd1')).toBe('/app/purchase/f1');
    const flightTask = { ...mine, department: 'flight' as const };
    expect(serviceNextHref(flightTask, 'd1')).toBe('/app/flight/f1');
    expect(serviceNextLinkText(flightTask)).toBe('Open Flight task');
  });

  it('facts summaries and lines never contain a selling value and cover every type', () => {
    expect(factsSummary(hotel)).toBe('Havelock · 14 Nov → 18 Nov · 1 room');
    expect(factsSummary(flight)).toBe('DEL → IXZ · 14 Nov, IXZ → DEL · 20 Nov · 2 passengers');
    expect(factsSummary(transfer)).toBe('14 Nov · Sedan · 3 passengers');
    expect(factsSummary(activity)).toBe('Havelock · 16 Nov · 4 participants');
    for (const facts of [hotel, flight, transfer, activity]) {
      const text = factsLines(facts).flat().join(' ');
      expect(text).not.toMatch(/₹|selling/i);
    }
    expect(factsLines(hotel).map(([label]) => label)).toEqual([
      'Hotel', 'City', 'Check-in', 'Check-out', 'Rooms', 'Room type', 'Meal plan', 'Adults', 'Children', 'Inclusions', 'Special requests',
    ]);
    expect(factsLines(flight)[0]).toEqual(['Segments', 'DEL → IXZ · 14 Nov; IXZ → DEL · 20 Nov']);
  });

  it('the type pill carries an icon and the frozen label; the progress pill uses the frozen words', () => {
    const pill = renderToStaticMarkup(createElement(ServiceTypePill, { type: 'transfer' }));
    expect(pill).toContain('<svg');
    expect(pill).toContain('Transfer or cab');
    const progress: DealProgress = { total: 3, byState: { planned: 0, notStarted: 1, inProgress: 1, supplierConfirmed: 1 }, fulfilled: false, staleCount: 0, needs: ['take_task', 'supplier_confirmation'] };
    expect(renderToStaticMarkup(createElement(ProgressPill, { progress }))).toContain('1 of 3 confirmed · 1 in progress · 1 not started');
    const empty: DealProgress = { total: 0, byState: { planned: 0, notStarted: 0, inProgress: 0, supplierConfirmed: 0 }, fulfilled: false, staleCount: 0, needs: [] };
    expect(renderToStaticMarkup(createElement(ProgressPill, { progress: empty }))).toContain('No services yet');
  });
});

describe('intake field helpers', () => {
  it('form field names used by the intake forms are the frozen ones', () => {
    for (const type of ['hotel', 'transfer', 'activity', 'flight'] as const) {
      for (const def of FACT_FIELDS[type]) expect(FIELD[def.key as keyof typeof FIELD], `${type}.${def.key}`).toBe(def.key);
    }
    expect(FIELD.segmentFrom).toBe('segmentFrom');
    expect(FIELD.travellerName).toBe('travellerName');
    expect(FIELD.settingValue).toBe('settingValue');
  });

  it('facts round-trip into string values and segments; paise become rupees', () => {
    const values = factsToValues(hotel, 'hotel');
    expect(values.hotelName).toBe('Synthetic Reef Resort');
    expect(values.children).toBe('1');
    expect(values.roomType).toBe('');
    expect(factsToValues(null, 'transfer')).toEqual({ route: '', date: '', pickupTime: '', vehicleType: '', passengers: '', notes: '' });
    expect(factsToSegments(flight)).toEqual([
      { from: 'DEL', to: 'IXZ', date: '2026-11-14' },
      { from: 'IXZ', to: 'DEL', date: '2026-11-20' },
    ]);
    expect(factsToSegments(null)).toEqual([{ from: '', to: '', date: '' }]);
    expect(paiseToRupees('4500000')).toBe('45000.00');
    expect(paiseToRupees(null)).toBe('');
  });

  it('the client-side mirror names missing and invalid fields after a refusal', () => {
    const problems = factProblems('hotel', { hotelName: '', city: 'X', checkIn: '2026-11-18', checkOut: '2026-11-14', rooms: '0', adults: '2', purchaseBudgetRupees: 'abc' });
    expect(problems.map((p) => p.key)).toEqual(['hotelName', 'rooms', 'checkOut', 'purchaseBudgetRupees']);
    expect(problems[0]!.text).toBe('Add hotel name.');
    const flightProblems = factProblems('flight', { passengers: '2' }, [{ from: 'de', to: 'IXZ', date: '2026-11-14' }, { from: 'IXZ', to: 'DEL', date: '2026-11-10' }]);
    expect(flightProblems.map((p) => p.key)).toEqual(['segment-0-from', 'segment-1-date']);
    expect(travellerProblems([{ fullName: ' ', type: 'adult' }, { fullName: 'Ok', type: 'child' }]).map((p) => p.key)).toEqual(['traveller-0-name']);
  });

  it('the fields an action names are mapped to the form keys (flight rows and travellers included)', () => {
    const named = problemsFromFields('flight', ['passengers', 'segmentFrom[1]', 'segmentDate[1]', 'purchaseBudgetRupees', 'rowVersion']);
    expect(named.map((p) => p.key)).toEqual(['passengers', 'segment-1-from', 'segment-1-date', 'purchaseBudgetRupees']);
    expect(travellerProblemsFromFields(['travellerName[2]', 'travellerType[0]', 'dealId']).map((p) => p.key)).toEqual(['traveller-2-name', 'traveller-0-type']);
  });

  it('counts travellers needed, planned tasks and the dialog lines', () => {
    expect(travellersNeeded([{ facts: hotel }, { facts: transfer }, { facts: activity }])).toBe(4);
    expect(plannedTaskCount([item(), item({ state: 'active', task: { taskId: 't', status: 'not_started', assigneeName: null, assignedToYou: false, supplierConfirmedAt: null } })])).toBe(1);
    const lines = confirmDialogLines(2, 1);
    expect(lines[0]).toContain('version 2');
    expect(lines[1]).toContain('creates 1 internal task:');
    expect(confirmDialogLines(1, 4)[1]).toContain('creates 4 internal tasks:');
    expect(confirmSuccessText(3)).toBe('Accepted version saved and 3 internal tasks created. Nothing is booked or paid yet.');
  });

  it('splits the checklist, appends service numbers and derives the overall stage', () => {
    const checklist: IntakeChecklist = {
      items: [
        { code: 'traveller_missing', blocking: true, owner: 'sales', itemNos: [] },
        { code: 'dates_outside_trip', blocking: false, owner: 'sales', itemNos: [2, 3] },
      ],
      canConfirm: false,
    };
    const groups = splitChecklist(checklist);
    expect(groups.blocking.map((i) => i.code)).toEqual(['traveller_missing']);
    expect(checklistItemText(groups.warnings[0]!)).toMatch(/\(services 2, 3\)$/);
    expect(intakeStage({ version: null, itemCount: 0, blockingCount: 0, canConfirm: false })).toBe('not_started');
    expect(intakeStage({ version: { status: 'draft' }, itemCount: 2, blockingCount: 1, canConfirm: false })).toBe('needs_details');
    expect(intakeStage({ version: { status: 'draft' }, itemCount: 2, blockingCount: 0, canConfirm: true })).toBe('ready');
    expect(intakeStage({ version: { status: 'confirmed' }, itemCount: 2, blockingCount: 0, canConfirm: false })).toBe('created');
  });
});

describe('Deal page services card', () => {
  const services: DealServicesView = {
    dealId: 'd0000000-0000-4000-8000-000000000001',
    version: { versionId: 'v', versionNo: 1, status: 'draft', rowVersion: 1, contentHash: 'h', serviceType: 'package' },
    items: [item(), item({ itemId: 'a2', itemNo: 2, serviceType: 'flight', department: 'flight', title: 'DEL → IXZ', facts: flight, purchaseBudgetPaise: undefined })],
    progress: { total: 2, byState: { planned: 2, notStarted: 0, inProgress: 0, supplierConfirmed: 0 }, fulfilled: false, staleCount: 0, needs: ['confirm_version'] },
    canEdit: true,
    canConfirm: true,
  };

  it('one row per item with type, title, department, owner, state and a next-step link', () => {
    const html = renderToStaticMarkup(createElement(DealServicesCard, { services, intakeHref: '/app/deals/d0000000-0000-4000-8000-000000000001/intake' }));
    expect(html.match(/<li /g)).toHaveLength(2);
    expect(html).toContain('Synthetic Reef Resort, Havelock');
    expect(html).toContain('Flight team');
    expect(html).toContain('Purchase (after confirmation)');
    expect(html).toContain('Planned · no task yet');
    expect(html).toContain('href="/app/deals/d0000000-0000-4000-8000-000000000001/intake"');
    expect(html).toContain('2 planned');
    expect(html).not.toContain('₹');
    expect(html).not.toMatch(/\sstyle="/);
  });

  it('an empty card is honest and the failed read never looks empty', () => {
    const empty = renderToStaticMarkup(createElement(DealServicesCard, { services: { ...services, items: [], progress: { ...services.progress, total: 0, byState: { planned: 0, notStarted: 0, inProgress: 0, supplierConfirmed: 0 }, needs: [] } } }));
    expect(empty).toContain('No services yet');
    const failed = renderToStaticMarkup(createElement(DealServicesUnavailable));
    expect(failed).toContain('Could not load the services');
    expect(failed).not.toContain('No services yet');
  });
});

describe('intake leaf views', () => {
  it('disabled, not-available and loading states keep one h1 and honest words', () => {
    expect(renderToStaticMarkup(createElement(IntakeDisabledView, { dealId: 'd1' }))).toContain('Service items are switched off for this CRM');
    const missing = renderToStaticMarkup(createElement(IntakeNotAvailableView));
    expect(missing).toContain('This deal does not exist, or it is not visible to you.');
    const loading = renderToStaticMarkup(createElement(IntakeLoading));
    expect(loading.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(loading.match(/role="status"/g)).toHaveLength(1);
    expect(loading.match(/aria-busy="true"/g)).toHaveLength(1);
  });

  it('the Deal page keeps its leaf-only imports (the services card is passed in by the route)', () => {
    const source = readFileSync(resolve(views, 'deal-page-view.tsx'), 'utf8');
    expect(source).not.toMatch(/from '\.\/(service-labels|deal-services-view|intake-views)'/);
  });
});
