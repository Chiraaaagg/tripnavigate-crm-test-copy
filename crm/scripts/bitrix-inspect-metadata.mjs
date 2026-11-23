#!/usr/bin/env node
// READ-ONLY Bitrix24 metadata inspection (Phase 2, contract §6).
//
// Usage (the credential comes ONLY from the process environment):
//   BITRIX_WEBHOOK_BASE_URL=<inbound webhook base URL> \
//   node scripts/bitrix-inspect-metadata.mjs --portal-domain <portal host> [--json] [--users]
//
// Prints deal pipelines (CATEGORY_ID), their stages (STAGE_ID) and deal field
// codes/types so the owner can confirm the category/stage/field map. It calls
// only crm.category.list, crm.status.list and crm.deal.fields: no deal records,
// customer data or amounts are read, and nothing is written to Bitrix. --users
// also lists portal users (user.get: id, name, email, active) for staff mapping.
// The base URL is never printed (it contains the webhook credential).
import {
  formatMetadata,
  formatUsers,
  inspectMetadata,
  inspectUsers,
  MetadataError,
  redact,
  resolveBaseUrl,
} from './lib/bitrix-metadata.mjs';

const raw = process.env.BITRIX_WEBHOOK_BASE_URL;
const secrets = [raw?.trim()];

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

try {
  const baseUrl = resolveBaseUrl(raw, arg('--portal-domain'), process.env.APP_ENV);
  secrets.push(baseUrl);
  const metadata = await inspectMetadata(baseUrl);
  const users = process.argv.includes('--users') ? await inspectUsers(baseUrl) : null;
  const out = process.argv.includes('--json')
    ? JSON.stringify(users ? { ...metadata, users } : metadata, null, 2)
    : [formatMetadata(metadata), ...(users ? ['', formatUsers(users)] : [])].join('\n');
  console.log(redact(out, secrets));
} catch (error) {
  const message = error instanceof MetadataError ? error.message : 'bitrix-inspect-metadata: unexpected failure';
  console.error(redact(message, secrets));
  process.exit(1);
}
