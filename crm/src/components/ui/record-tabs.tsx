import type { TabItemVM } from '@/modules/deals/workspace-contract';
import { Tabs, type TabsVariant } from './tabs';

/**
 * Record tabs (P-TABS): server-rendered links (`?tab=`), one per tab the
 * viewer may open, never with a count (money-privacy P6). Look from shadcn
 * Tabs 953 (underline variant of the CRM's link tabs); semantics stay
 * navigation with aria-current="page", so they work without script.
 * UX redesign R2: optional `variant` ("pill" is the C5 look of the record
 * pages). Left out, the Tabs default (underline) applies, as before.
 */
export function RecordTabs<T extends string>({ tabs, label, className, variant }: { tabs: TabItemVM<T>[]; label: string; className?: string; variant?: TabsVariant }) {
  return <Tabs label={label} className={className} variant={variant} items={tabs.map((t) => ({ href: t.href, label: t.label, current: t.current }))} />;
}
