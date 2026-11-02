#!/usr/bin/env node
// CI (T13, real stack): runs AFTER a fresh `supabase db reset` (no fixtures)
// and after scripts/bootstrap-first-admin.mjs has been run for BOOTSTRAP_EMAIL.
// Checks: exactly one non-inactive super_admin (bootstrap creates it INVITED;
// it becomes active only after onboarding) with that email, the audit event
// staff.bootstrap_admin carrying details.operator, and the invitation email in
// Mailpit linking to /auth/confirm?type=invite. Local stack only.
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const email = process.env.BOOTSTRAP_EMAIL?.toLowerCase();
const operator = process.env.BOOTSTRAP_OPERATOR;
const mailpit = (process.env.MAILPIT_URL ?? 'http://127.0.0.1:54324').replace(/\/$/, '');

const problems = [];
function done() {
  if (problems.length > 0) {
    for (const p of problems) console.log(`::error title=bootstrap verification::${p}`);
    process.exit(1);
  }
  console.log('::notice title=bootstrap verification::first administrator created once, audited with operator, invitation emailed');
}

if (!url || !secret || !email || !operator) {
  problems.push('SUPABASE_URL, SUPABASE_SECRET_KEY, BOOTSTRAP_EMAIL and BOOTSTRAP_OPERATOR are required');
  done();
}
if (!['localhost', '127.0.0.1'].includes(new URL(url).hostname)) {
  problems.push('verify-bootstrap runs only against a local stack');
  done();
}

const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });

const supers = await admin.from('memberships').select('user_id').eq('role_code', 'super_admin').neq('status', 'inactive');
if (supers.error) problems.push(`memberships: ${supers.error.message}`);
const ids = [...new Set((supers.data ?? []).map((m) => m.user_id))];
if (ids.length !== 1) problems.push(`expected exactly 1 non-inactive super_admin, found ${ids.length}`);

const profile = ids[0]
  ? await admin.from('staff_profiles').select('work_email, status').eq('user_id', ids[0]).maybeSingle()
  : { data: null };
if (profile.data?.work_email?.toLowerCase() !== email) problems.push('the super_admin is not the bootstrap email');
if (profile.data && profile.data.status !== 'invited') {
  problems.push(`bootstrap profile should be invited until onboarding, found ${profile.data.status}`);
}

const audit = await admin.from('audit_events').select('action, details').eq('action', 'staff.bootstrap_admin');
if (audit.error) problems.push(`audit_events: ${audit.error.message}`);
const events = audit.data ?? [];
if (events.length !== 1) problems.push(`expected exactly 1 staff.bootstrap_admin audit event, found ${events.length}`);
if (events[0] && events[0].details?.operator !== operator) problems.push('audit event details.operator does not match BOOTSTRAP_OPERATOR');

const list = await fetch(`${mailpit}/api/v1/messages?limit=200`).then((r) => r.json());
const invites = (list.messages ?? []).filter((m) => m.To?.some((t) => t.Address?.toLowerCase() === email));
if (invites.length !== 1) problems.push(`expected exactly 1 invitation email in Mailpit, found ${invites.length}`);
if (invites[0]) {
  const message = await fetch(`${mailpit}/api/v1/message/${invites[0].ID}`).then((r) => r.json());
  const body = `${message.HTML ?? ''} ${message.Text ?? ''}`.replace(/&amp;/g, '&');
  if (!/\/auth\/confirm\?token_hash=[A-Za-z0-9_-]+&type=invite/.test(body)) {
    problems.push('invitation email has no /auth/confirm?token_hash=...&type=invite link');
  }
}
done();
