// Helpers for GitHub Actions workflow-command annotations (pure; unit-tested).

/** GitHub workflow command data encoding: % first, then CR and LF. */
export function encodeAnnotation(text) {
  return String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export function decodeAnnotation(text) {
  return String(text).replace(/%0A/g, '\n').replace(/%0D/g, '\r').replace(/%25/g, '%');
}

/** Encoding for property values (title=...), which also escape : and ,. */
export function encodeProperty(text) {
  return encodeAnnotation(text).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

/**
 * Splits text into chunks whose ENCODED length is at most `max`, never
 * splitting a character's encoding. Concatenating decoded chunks gives the text.
 */
export function chunkForAnnotations(text, max = 60_000) {
  const chunks = [];
  let current = '';
  let size = 0;
  for (const ch of String(text)) {
    const cost = ch === '%' || ch === '\n' || ch === '\r' ? 3 : ch.length;
    if (size + cost > max && current.length > 0) {
      chunks.push(current);
      current = '';
      size = 0;
    }
    current += ch;
    size += cost;
  }
  if (current.length > 0 || chunks.length === 0) chunks.push(current);
  return chunks;
}

/** Drops leading `//` comment lines (a human header above generated content). */
export function stripLeadingCommentHeader(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length && (lines[i].startsWith('//') || (lines[i].trim() === '' && i > 0 && lines[i - 1].startsWith('//')))) {
    i += 1;
  }
  return lines.slice(i).join('\n');
}
