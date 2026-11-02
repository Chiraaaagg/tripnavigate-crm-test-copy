/**
 * Static stand-in for LiveDealsRefresh in design previews (no realtime
 * connection here). Same markup as the component's "Live" state.
 */
export function PreviewLiveIndicator() {
  return (
    <p className="live-indicator live" role="status" aria-live="polite">
      <span aria-hidden="true" className="status-glyph">
        ●
      </span>
      Live updates on
    </p>
  );
}
