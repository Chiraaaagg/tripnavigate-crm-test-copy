'use client';

import { useEffect } from 'react';

/**
 * Progressive enhancement for the account menu (a native <details>, which
 * works without script): close it on Escape (focus returns to its summary if
 * it was inside the menu) and on a click outside. Renders nothing.
 */
export function UserMenuDismiss({ menuId }: { menuId: string }) {
  useEffect(() => {
    const menu = document.getElementById(menuId);
    if (!(menu instanceof HTMLDetailsElement)) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !menu.open) return;
      const focusWasInside = menu.contains(document.activeElement);
      menu.open = false;
      // Return focus to the summary only when it was inside the menu; never steal it from elsewhere.
      if (focusWasInside) menu.querySelector<HTMLElement>(':scope > summary')?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (menu.open && event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [menuId]);
  return null;
}
