'use client';

import { useEffect } from 'react';

/**
 * UNUSED since the Lagoon app frame (9 October 2026): the section links moved
 * from a horizontally scrolling row into the menu drawer, so nothing renders
 * this component. Kept (the team deletes no files); safe to move to history.
 *
 * On narrow screens the main navigation is one horizontally scrolling row.
 * Bring the current page's link into view so people can see where they are.
 * No visual effect on desktop, where the list is vertical and fully visible.
 */
export function NavCurrentIntoView() {
  useEffect(() => {
    const current = document.querySelector<HTMLElement>('.shell-nav [aria-current="page"]');
    const row = current?.closest('ul');
    if (!current || !row || row.scrollWidth <= row.clientWidth) return;
    row.scrollLeft = current.offsetLeft - (row.clientWidth - current.offsetWidth) / 2;
  });
  return null;
}
