'use client';

import { Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** Opens the browser's print dialog for the print view (no inline script: CSP-safe). */
export function PrintButton({ label = 'Print' }: { label?: string }) {
  return (
    <Button type="button" variant="primary" onClick={() => window.print()}>
      <Printer aria-hidden="true" />
      {label}
    </Button>
  );
}
