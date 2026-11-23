export type StatusTone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral';

/**
 * Glyph + words status pill. The glyph is decoration (aria-hidden); the text
 * always carries the meaning, so status never relies on colour or symbol alone.
 */
export function StatusPill({
  tone,
  glyph,
  children,
  label,
}: {
  tone: StatusTone;
  glyph: string;
  children: React.ReactNode;
  /** Optional visually hidden prefix such as "Booking status:". */
  label?: string;
}) {
  return (
    <span className={`status-pill ${tone}`}>
      <span className="status-glyph" aria-hidden="true">
        {glyph}
      </span>
      {label ? <span className="visually-hidden">{label} </span> : null}
      {children}
    </span>
  );
}
