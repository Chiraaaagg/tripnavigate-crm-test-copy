#!/usr/bin/env node
// CI: compares the committed src/lib/database.types.ts with freshly generated
// types. On drift it FAILS and publishes the full generated file as GitHub
// notice annotations so it can be retrieved through the public API without
// log access:
//   ::notice title=database.types chunk N of M::<url-encoded text>
// Encoding: % -> %25, \r -> %0D, \n -> %0A (GitHub workflow command rules).
// Each annotation message is at most 60 000 characters after encoding.
//
// Usage: node scripts/ci/check-database-types.mjs <generated-file> [committed-file]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chunkForAnnotations, encodeAnnotation, stripLeadingCommentHeader } from './annotations.mjs';

const generatedPath = process.argv[2];
const committedPath = process.argv[3] ?? join(import.meta.dirname, '..', '..', 'src', 'lib', 'database.types.ts');
if (!generatedPath) {
  console.log('::error title=database.types::generated file path argument is required');
  process.exit(2);
}

const generated = readFileSync(generatedPath, 'utf8');
const committed = readFileSync(committedPath, 'utf8');
if (generated.trim().length === 0) {
  console.log('::error title=database.types::type generation produced an empty file');
  process.exit(1);
}

// Line-trailing whitespace is ignored: `supabase gen types` emits some, and the
// committed file is kept clean for `git diff --check`.
const normalise = (text) => text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trimEnd();
if (normalise(stripLeadingCommentHeader(committed)) === normalise(generated)) {
  console.log('::notice title=database.types::committed src/lib/database.types.ts matches the generated types');
  process.exit(0);
}

// GitHub's annotations API truncated the original 60k chunk at 4096 chars.
// Keep readable fallback chunks small; the workflow also uploads a full artifact.
const chunks = chunkForAnnotations(generated, 3_000);
console.log(
  `::error title=database.types drift::src/lib/database.types.ts differs from \`supabase gen types\`. The generated file follows in ${chunks.length} annotation(s) (notice, then warning, then error level); concatenate the decoded chunks in order.`,
);
// GitHub keeps at most 10 annotations of each level per step, so spill the
// chunks across notice, warning and error levels (29 chunks, ~87 KB maximum).
const LEVELS = ['notice', 'warning', 'error'];
const PER_LEVEL = [10, 10, 9];
const capacity = PER_LEVEL.reduce((a, b) => a + b, 0);
if (chunks.length > capacity) {
  console.log(`::error title=database.types drift::generated types exceed ${capacity} annotation chunks; download the workflow artifact instead.`);
}
chunks.slice(0, capacity).forEach((chunk, i) => {
  let level = 0;
  let offset = i;
  while (offset >= PER_LEVEL[level]) {
    offset -= PER_LEVEL[level];
    level += 1;
  }
  console.log(`::${LEVELS[level]} title=database.types chunk ${i + 1} of ${chunks.length}::${encodeAnnotation(chunk)}`);
});
process.exit(1);
