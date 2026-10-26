import { isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DealDetail } from '@/modules/deals/dto';
import { DealOverviewTab } from '@/views/deal-workspace/overview';
import { HomeView, type MembershipLine, MyAccessView } from '@/views/staff-views';

/** Every array of sibling elements in the (unrendered) tree must have unique keys. */
function duplicateKeys(node: ReactNode, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    const keys = node.filter(isValidElement).map((child) => child.key);
    for (const key of keys) if (key !== null && keys.indexOf(key) !== keys.lastIndexOf(key)) found.push(key);
    for (const child of node) duplicateKeys(child, found);
  } else if (isValidElement<{ children?: ReactNode }>(node)) {
    duplicateKeys(node.props.children, found);
  }
  return found;
}

const deal: DealDetail = {
  id: '00000000-0000-4000-8000-000000000001',
  reference: 'D-0001',
  title: 'Synthetic Goa trip',
  branchName: 'Jodhpur',
  relation: 'owner',
  createdOn: '2026-10-06',
  assignments: [
    { kind: 'sales', isYou: false },
    { kind: 'sales', isYou: false },
    { kind: 'purchase', isYou: true },
  ],
  commercial: { visible: false },
  commercialAbsence: 'withheld',
};

// The same branch name and role can exist in two legal entities.
const memberships: MembershipLine[] = [
  { branchName: 'Jodhpur', roleName: 'Sales', isHeadOffice: false, legalEntityName: 'Synthetic Entity A' },
  { branchName: 'Jodhpur', roleName: 'Sales', isHeadOffice: false, legalEntityName: 'Synthetic Entity B' },
];

describe('staff views list keys', () => {
  it('two other staff with the same assignment kind get distinct keys', () => {
    // Batch 1: the team list moved to the Deal workspace Overview tab.
    const team = deal.assignments.map((a) => ({ kindLabel: a.kind, isYou: a.isYou }));
    const tree = DealOverviewTab({ overview: { branchName: deal.branchName, createdOn: deal.createdOn, relation: deal.relation, team, tripText: null, travellersText: null } });
    expect(duplicateKeys(tree)).toEqual([]);
    // The check is live: the rendered team list really holds the three people, two of one kind.
    const html = renderToStaticMarkup(tree);
    expect(html.match(/<li[\s>]/g)).toHaveLength(3);
    expect(html.match(/sales: a colleague/g)).toHaveLength(2);
  });

  it('memberships with the same branch and role in two entities get distinct keys', () => {
    expect(duplicateKeys(HomeView({ displayName: 'Synthetic', memberships, counts: { visible: 0, owned: 0, assigned: 0 } }))).toEqual([]);
    expect(duplicateKeys(MyAccessView({ memberships, grants: [] }))).toEqual([]);
  });
});
