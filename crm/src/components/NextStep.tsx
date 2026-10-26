import type { ReactNode } from 'react';

/** "Who acts next" and "Next step", shown near the top of every work screen. */
export function NextStep({ who, next, label = 'Who acts next' }: { who: ReactNode; next: ReactNode; label?: string }) {
  return (
    <dl className="next-step">
      <dt>{label}</dt>
      <dd>{who}</dd>
      <dt>Next step</dt>
      <dd>{next}</dd>
    </dl>
  );
}
