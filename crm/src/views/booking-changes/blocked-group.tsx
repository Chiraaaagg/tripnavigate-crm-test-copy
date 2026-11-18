'use client';

import { useId } from 'react';
import { Button } from '@/components/ui/button';

/*
 * Several actions that are unavailable for the same reason: every button
 * stays focusable (aria-disabled) and points at one shared reason line, so
 * the reason is read once instead of under each button.
 */
export function BlockedGroup({ labels, reason, primaryIndex = 0 }: { labels: string[]; reason: string; primaryIndex?: number }) {
  const id = useId();
  return (
    <div className="flex flex-col items-start gap-1.5">
      <div className="flex flex-wrap gap-3">
        {labels.map((label, i) => (
          <Button key={label} type="button" size="sm" variant={i === primaryIndex ? 'primary' : 'secondary'} aria-disabled="true" aria-describedby={id} onClick={(e) => e.preventDefault()}>
            {label}
          </Button>
        ))}
      </div>
      <p id={id} className="m-0 text-sm text-quiet">
        {reason}
      </p>
    </div>
  );
}
