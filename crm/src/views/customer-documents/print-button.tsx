'use client';

import { Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Opens the browser's print dialog for the print view (no inline script: CSP-safe).
 * `variant` (R2, additive): 'secondary' where another action is the page's one
 * primary (the quotation Customer copy beside "Mark as shared"). Default unchanged.
 */
export function PrintButton({ label = 'Print', variant = 'primary' }: { label?: string; variant?: 'primary' | 'secondary' }) {
  return (
    <Button type="button" variant={variant} onClick={() => window.print()}>
      <Printer aria-hidden="true" />
      {label}
    </Button>
  );
}
