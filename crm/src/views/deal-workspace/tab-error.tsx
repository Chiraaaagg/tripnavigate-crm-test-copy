import { RefreshCw } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Notice } from '@/components/ui/notice';

/** G-14 shared sentence: "{Thing} did not load. Nothing was changed. Reload the page. If it keeps happening, tell your admin." */
export function didNotLoadText(thing: string): string {
  return `${thing} did not load. Nothing was changed. Reload the page. If it keeps happening, tell your admin.`;
}

/**
 * One tab or card that could not be loaded (SH-06): the rest of the record
 * stays. Never shown as an empty state or zero.
 */
export function TabUnavailable({ thing, message }: { thing: string; /** Replaces the shared sentence when a screen has its own (e.g. Documents). */ message?: string }) {
  return (
    <Card>
      <div className="px-4.5 py-4">
        <Notice tone="danger" icon={RefreshCw} role="status">
          <p>{message ?? didNotLoadText(thing)}</p>
        </Notice>
      </div>
    </Card>
  );
}

/** Deal workspace name for the same card (luna-batch1-props.md). */
export const DealTabUnavailable = TabUnavailable;
