import type { Locator } from '@playwright/test';

/**
 * The visible primary actions inside `scope`: buttons and links (found by
 * role) whose fill is the brand colour (--color-brand-strong, #004AAD; the old
 * `.button` style uses the same colour as --color-primary). Returns their
 * visible text, in page order. A link marked aria-current (the current filter
 * chip or tab) shares the colour but is not an action, so it is left out.
 *
 * UX redesign R0 (code-quality finding 15): replaces lookups by style class
 * (`.bg-brand-strong`, `.button:not(.secondary)`), which break when the
 * redesign renames or regroups classes. The check is by role and by the
 * colour the person sees.
 */
export async function primaryActions(scope: Locator): Promise<string[]> {
  // A pointer resting on a button would show its hover colour instead.
  await scope.page().mouse.move(0, 0);
  const actions = scope.getByRole('button').or(scope.getByRole('link')).filter({ visible: true });
  return actions.evaluateAll((elements) => {
    const probe = document.createElement('span');
    probe.style.backgroundColor = 'var(--color-brand-strong)';
    document.body.append(probe);
    const brand = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return elements
      .filter((el) => !el.hasAttribute('aria-current') && getComputedStyle(el).backgroundColor === brand)
      .map((el) => (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim());
  });
}

/**
 * Every visible element inside `scope` that carries the brand emphasis: a brand
 * fill or a brand border (--color-brand-strong). Returns a short label per
 * element (its role or tag, and its text). This is the role-free equivalent of
 * the old class lookup `.border-brand-strong, [class*="bg-brand-strong"]`,
 * which also counted brand-outlined cards and chips, not only actions.
 */
export async function brandEmphasis(scope: Locator): Promise<string[]> {
  await scope.page().mouse.move(0, 0);
  return scope.locator('*').filter({ visible: true }).evaluateAll((elements) => {
    const probe = document.createElement('span');
    probe.style.backgroundColor = 'var(--color-brand-strong)';
    document.body.append(probe);
    const brand = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const brandBorder = (s: CSSStyleDeclaration) =>
      (['Top', 'Right', 'Bottom', 'Left'] as const).every((side) =>
        s.getPropertyValue(`border-${side.toLowerCase()}-style`) !== 'none'
        && parseFloat(s.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0
        && s.getPropertyValue(`border-${side.toLowerCase()}-color`) === brand);
    return elements
      .filter((el) => {
        const s = getComputedStyle(el);
        return s.backgroundColor === brand || brandBorder(s);
      })
      .map((el) => `${el.getAttribute('role') ?? el.tagName.toLowerCase()}: ${(el as HTMLElement).innerText.replace(/\s+/g, ' ').trim().slice(0, 60)}`);
  });
}
