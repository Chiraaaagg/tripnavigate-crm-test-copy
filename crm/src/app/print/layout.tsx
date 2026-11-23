import type { ReactNode } from 'react';

/**
 * Print-only layout for documents the online PDF maker opens (DEC-49). The
 * root layout still provides <html>, fonts and the nonce; inside this subtree
 * the page carries no app chrome: no staff shell, and the environment banner
 * and skip link of the root layout are hidden by document.css whenever a
 * .tn-print-root is on the page (body:has), so they never reach a PDF.
 */
export default function PrintLayout({ children }: { children: ReactNode }) {
  return <div className="tn-print-root">{children}</div>;
}
