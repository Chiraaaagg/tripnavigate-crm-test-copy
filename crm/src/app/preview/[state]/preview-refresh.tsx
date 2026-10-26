'use client';

import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

/**
 * Preview gallery only: re-reads the page on the server the way the live
 * list refresh does (router.refresh), so a test can show that a refresh of
 * the list keeps the search results and the typed words.
 */
export function PreviewRefreshButton() {
  const router = useRouter();
  return (
    <Button type="button" variant="ghost" size="sm" onClick={() => router.refresh()} data-slot="preview-refresh">
      Refresh the list (preview)
    </Button>
  );
}
