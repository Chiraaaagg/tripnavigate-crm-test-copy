import type { TabItemVM } from '@/modules/deals/workspace-contract';
import { Tabs } from './tabs';

/**
 * Record tabs (P-TABS): server-rendered links (`?tab=`), one per tab the
 * viewer may open, never with a count (money-privacy P6). Look from shadcn
 * Tabs 953 (underline variant of the CRM's link tabs); semantics stay
 * navigation with aria-current="page", so they work without script.
 */
export function RecordTabs<T extends string>({ tabs, label, className }: { tabs: TabItemVM<T>[]; label: string; className?: string }) {
  return <Tabs label={label} className={className} items={tabs.map((t) => ({ href: t.href, label: t.label, current: t.current }))} />;
}
