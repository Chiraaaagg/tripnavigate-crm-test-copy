import type { FormState } from '@/lib/forms';

/** Announces form outcomes to assistive technology; text, not colour, carries meaning. */
export function FormMessage({ state, id }: { state: FormState; id?: string }) {
  if (state.status === 'error' && state.message) {
    return (
      <div id={id} className="message error" role="alert">
        <strong>Error: </strong>
        {state.message}
      </div>
    );
  }
  if (state.status === 'success' && state.message) {
    return (
      <div id={id} className="message success" role="status">
        <strong>Done: </strong>
        {state.message}
      </div>
    );
  }
  return <div id={id} role="status" aria-live="polite" />;
}
