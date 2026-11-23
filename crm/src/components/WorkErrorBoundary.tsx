'use client';

import { catchError, type ErrorInfo } from 'next/error';

/**
 * Error boundary for a work area (booking panel, Purchase task). It replaces
 * only that area, never shows the error's text (it may be technical), says
 * that nothing new was saved, and offers a retry that re-fetches the page.
 */
function WorkErrorFallback({ title }: { title: string }, { retry }: ErrorInfo) {
  return (
    <section className="work-panel" aria-labelledby="work-error-heading" role="alert">
      <div className="work-panel-head">
        <div>
          <span className="eyebrow">{title}</span>
          <h2 id="work-error-heading">Something went wrong</h2>
          <p className="mb-0">
            This area could not be shown. If you had just submitted something, we couldn’t confirm whether it
            worked — reload the page to check. If it keeps happening, tell your admin.
          </p>
        </div>
        <div className="primary-slot">
          <button type="button" className="button" onClick={() => retry()}>
            Try again
          </button>
        </div>
      </div>
    </section>
  );
}

export const WorkErrorBoundary = catchError(WorkErrorFallback);
