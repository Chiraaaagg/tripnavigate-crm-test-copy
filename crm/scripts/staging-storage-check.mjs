#!/usr/bin/env node
// Phase 3.5: verifies the private proof bucket on the HOSTED STAGING project
// through the real Storage API, then deletes exactly what it created.
//
// Usage:
//   STAGING_SECRETS_FILE=<path to dotenv file holding SUPABASE_SECRET_KEY> \
//   node scripts/staging-storage-check.mjs --project-ref <staging ref>
//   Optional: STAGING_PUBLISHABLE_KEY=<publishable key> adds an anon-key probe.
//
// Checks (all objects live under booking-evidence/staging-verification/<UTC ts>/):
//   1. The secret key belongs to the given project (bucket metadata readable).
//   2. Bucket booking-evidence is private, 4 MiB limit, pdf/jpeg/png/webp only.
//   3. A small synthetic PDF uploads.
//   4. A synthetic PDF of 4 MiB + 1 byte is refused.
//   5. A disallowed MIME type (text/plain) is refused.
//   6. The public URL, an unauthenticated authenticated-URL, and (optional) an
//      anon-key download of the small object all fail.
//   7. Everything under the run prefix (listed, plus anything the client
//      believes it created) is deleted one by one; the prefix must list empty.
//
// The secrets file is parsed as data (never sourced or printed). Output never
// contains keys, tokens or object contents.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Only the staging project is accepted. The ref itself is not written in
// source (the code is mirrored to a public test copy): this is the SHA-256 of
// the one accepted ref, so the check still accepts exactly that project.
const STAGING_REF_SHA256 =
  "f3864b967d308cb6a331ed49c04f50faa8f1fd7b9cd7c5381c9259eb51819bf9";
const BUCKET = "booking-evidence";
const LIMIT = 4194304;

function fail(message) {
  console.error(`staging-storage-check: ${message}`);
  process.exit(2);
}

const refIndex = process.argv.indexOf("--project-ref");
const ref = refIndex > 0 ? process.argv[refIndex + 1] : undefined;
if (
  typeof ref !== "string" ||
  createHash("sha256").update(ref).digest("hex") !== STAGING_REF_SHA256
)
  fail("--project-ref must be the staging project ref");
const secretsFile = process.env.STAGING_SECRETS_FILE;
if (!secretsFile) fail("STAGING_SECRETS_FILE is required");

function parseDotenv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
    );
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}
const secret = parseDotenv(
  readFileSync(secretsFile, "utf8"),
).SUPABASE_SECRET_KEY;
if (!secret) fail("SUPABASE_SECRET_KEY missing in secrets file");
const publishable = process.env.STAGING_PUBLISHABLE_KEY || "";
const base = `https://${ref}.supabase.co/storage/v1`;
const redact = (s) =>
  String(s)
    .split(secret)
    .join("[redacted]")
    .split(publishable || "\u0000")
    .join("[redacted]");
const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail: redact(detail) });
}
const admin = { apikey: secret, authorization: `Bearer ${secret}` };

async function status(res) {
  let code = "";
  try {
    const body = await res.json();
    code = body.statusCode ?? body.error ?? "";
  } catch {
    /* non-JSON body */
  }
  return `http ${res.status}${code ? ` (${code})` : ""}`;
}

function pdf(size) {
  const head = Buffer.from("%PDF-1.4\n% synthetic staging verification\n");
  const tail = Buffer.from("\n%%EOF\n");
  const body = Buffer.alloc(
    Math.max(0, size - head.length - tail.length),
    0x20,
  );
  return Buffer.concat([head, body, tail]);
}

async function upload(path, bytes, contentType) {
  return fetch(`${base}/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: { ...admin, "content-type": contentType, "x-upsert": "false" },
    body: bytes,
  });
}

const ts = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace(/\.\d+Z$/, "Z");
const prefix = `staging-verification/${ts}`;
const small = `${prefix}/small.pdf`;
const big = `${prefix}/over-limit.pdf`;
const txt = `${prefix}/wrong-type.txt`;
const created = new Set();

try {
  // 1 + 2
  const b = await fetch(`${base}/bucket/${BUCKET}`, { headers: admin });
  if (b.status !== 200)
    fail(`secret key does not read bucket on ${ref}: ${await status(b)}`);
  const bucket = await b.json();
  record(
    "key_pairs_with_staging_project",
    true,
    `bucket ${bucket.id} readable on ${ref}`,
  );
  const mimes = [...(bucket.allowed_mime_types ?? [])].sort().join(",");
  record("bucket_private", bucket.public === false, `public=${bucket.public}`);
  record(
    "bucket_limit_4mib",
    bucket.file_size_limit === LIMIT,
    `file_size_limit=${bucket.file_size_limit}`,
  );
  record(
    "bucket_mime_types",
    mimes === "application/pdf,image/jpeg,image/png,image/webp",
    `allowed_mime_types=${mimes}`,
  );

  // 3
  const up = await upload(small, pdf(1024), "application/pdf");
  if (up.ok) created.add(small);
  record("small_pdf_upload_ok", up.ok, await status(up));

  // 4
  const over = await upload(big, pdf(LIMIT + 1), "application/pdf");
  if (over.ok) created.add(big);
  record("over_limit_upload_refused", !over.ok, await status(over));

  // 5
  const wrong = await upload(txt, Buffer.from("synthetic"), "text/plain");
  if (wrong.ok) created.add(txt);
  record("wrong_mime_upload_refused", !wrong.ok, await status(wrong));

  // 6
  const pub = await fetch(`${base}/object/public/${BUCKET}/${small}`);
  record("public_url_refused", !pub.ok, await status(pub));
  const unauth = await fetch(`${base}/object/authenticated/${BUCKET}/${small}`);
  record("unauthenticated_download_refused", !unauth.ok, await status(unauth));
  const direct = await fetch(`${base}/object/${BUCKET}/${small}`);
  record("no_header_download_refused", !direct.ok, await status(direct));
  if (publishable) {
    const anon = await fetch(
      `${base}/object/authenticated/${BUCKET}/${small}`,
      {
        headers: {
          apikey: publishable,
          authorization: `Bearer ${publishable}`,
        },
      },
    );
    record("anon_key_download_refused", !anon.ok, await status(anon));
  }
} catch (error) {
  record("run_completed", false, `error: ${error?.name ?? "Error"}`);
} finally {
  // 7: delete everything under this run's prefix (not only what the client
  // believes it created: a timeout after a server-side commit can still leave
  // an object), each delete isolated, then always prove the prefix is empty.
  // Returns full object paths under the run prefix, or null if listing failed.
  async function listPrefix() {
    try {
      const res = await fetch(`${base}/object/list/${BUCKET}`, {
        method: "POST",
        headers: { ...admin, "content-type": "application/json" },
        body: JSON.stringify({ prefix: `${prefix}/`, limit: 100, offset: 0 }),
      });
      if (!res.ok) return null;
      const rows = await res.json();
      return rows.map((row) => `${prefix}/${row.name}`);
    } catch {
      return null;
    }
  }

  const listed = (await listPrefix()) ?? [];
  const targets = new Set([...created, ...listed]);
  let deleteFailures = 0;
  for (const path of targets) {
    try {
      const del = await fetch(`${base}/object/${BUCKET}`, {
        method: "DELETE",
        headers: { ...admin, "content-type": "application/json" },
        body: JSON.stringify({ prefixes: [path] }),
      });
      if (!del.ok) deleteFailures += 1;
    } catch {
      deleteFailures += 1;
    }
  }
  if (targets.size > 0) {
    record(
      "cleanup_delete",
      deleteFailures === 0,
      `requested ${targets.size} object(s); failures=${deleteFailures}`,
    );
  }

  const after = await listPrefix();
  const remaining = after === null ? -1 : after.length;
  record(
    "prefix_empty_after_cleanup",
    remaining === 0,
    `remaining=${remaining}${after === null ? " (listing failed)" : ""}`,
  );
}

console.log(JSON.stringify({ project: ref, prefix, results }, null, 2));
process.exit(results.every((r) => r.pass) ? 0 : 1);
