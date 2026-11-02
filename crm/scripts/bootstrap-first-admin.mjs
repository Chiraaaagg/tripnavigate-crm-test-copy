#!/usr/bin/env node
// Creates the FIRST administrator of a TripNavigate CRM environment
// (contract docs/implementation/phase-1-5-contract.md, section 1).
//
// Usage:
//   APP_ENV=<local|staging|production> SUPABASE_URL=<url> SUPABASE_SECRET_KEY=<secret> \
//   BOOTSTRAP_OPERATOR="<who is running this>" SITE_URL=<app base url> \
//   node scripts/bootstrap-first-admin.mjs --email <work email> --display-name "<name>" \
//     --branch-code JDH --confirm-project-ref <project ref | local>
//
// Behaviour:
//   - Refuses when any active super_admin exists, unless it is the same email
//     (repeat-safe no-op: exit 0, outcome already_admin, no email sent).
//   - Sends a normal invitation (inviteUserByEmail -> /auth/confirm). The
//     administrator still sets a password and enrols MFA through that link.
//   - Then calls public.bootstrap_first_admin (service role only), which
//     creates the profile/membership and audits staff.bootstrap_admin with the
//     operator. Nothing personal is committed; inputs come from the command line.
//   - Never prints keys or tokens.
import { createClient } from '@supabase/supabase-js';
import {
  BootstrapGuardError,
  decideBootstrap,
  parseBootstrapArgs,
  redact,
  validateBootstrap,
} from './lib/bootstrap-guards.mjs';

const secrets = [process.env.SUPABASE_SECRET_KEY];
const log = (message) => console.log(`bootstrap-first-admin: ${redact(message, secrets)}`);
function fail(message, code = 1) {
  console.error(`bootstrap-first-admin: ${redact(message, secrets)}`);
  process.exit(code);
}

let plan;
try {
  plan = validateBootstrap(parseBootstrapArgs(process.argv.slice(2)), process.env);
} catch (error) {
  if (error instanceof BootstrapGuardError) fail(error.message, 2);
  throw error;
}

const admin = createClient(plan.supabaseUrl, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

async function activeSuperAdminEmails() {
  const memberships = await admin
    .from('memberships')
    .select('user_id')
    .eq('role_code', 'super_admin')
    .neq('status', 'inactive');
  if (memberships.error) throw new Error(`could not read memberships: ${memberships.error.message}`);
  const ids = [...new Set((memberships.data ?? []).map((m) => m.user_id))];
  if (ids.length === 0) return [];
  // Same rule as public.bootstrap_first_admin: an INVITED (not yet onboarded)
  // super_admin counts too; only inactive profiles/memberships are ignored.
  const profiles = await admin
    .from('staff_profiles')
    .select('work_email')
    .in('user_id', ids)
    .neq('status', 'inactive');
  if (profiles.error) throw new Error(`could not read staff profiles: ${profiles.error.message}`);
  return (profiles.data ?? []).map((p) => p.work_email);
}

async function findAuthUserId() {
  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`could not list Auth users: ${error.message}`);
    const hit = data.users.find((u) => u.email?.toLowerCase() === plan.email);
    if (hit) return hit.id;
    if (data.users.length < 200) return null;
  }
  throw new Error('too many Auth users to search; refusing to guess');
}

async function callBootstrap(userId) {
  const { data, error } = await admin.rpc('bootstrap_first_admin', {
    p_user_id: userId,
    p_email: plan.email,
    p_display_name: plan.displayName,
    p_branch_code: plan.branchCode,
    p_operator: plan.operator,
  });
  if (error) throw new Error(`bootstrap_first_admin refused (${error.code ?? 'error'}): ${error.message}`);
  return data;
}

try {
  log(`target ${plan.projectRef} (APP_ENV=${plan.appEnv}), branch ${plan.branchCode}`);
  const decision = decideBootstrap(await activeSuperAdminEmails(), plan.email);
  if (decision === 'refuse') {
    fail('an active super administrator already exists; use the staff screen to invite more administrators.', 3);
  }

  let userId = await findAuthUserId();
  if (decision === 'already_admin') {
    if (!userId) fail('administrator profile exists but its Auth user was not found; investigate manually.', 4);
  } else if (!userId) {
    const invite = await admin.auth.admin.inviteUserByEmail(plan.email, { redirectTo: plan.redirectTo });
    if (invite.error || !invite.data.user) {
      fail(`invitation could not be handed to the mail service: ${invite.error?.message ?? 'no user returned'}`);
    }
    userId = invite.data.user.id;
    log('invitation handed to the mail service.');
  } else {
    // A previous run created the Auth user but did not finish; do not email again.
    log('Auth user already exists (earlier partial run); not sending another invitation.');
  }

  const result = await callBootstrap(userId);
  const outcome = result?.outcome ?? 'unknown';
  log(`outcome=${outcome} user_id=${userId}`);
  if (outcome !== 'created' && outcome !== 'already_admin') fail('unexpected result from bootstrap_first_admin');
  if (outcome === 'created') {
    log('next: the administrator opens the invitation link, sets a password and enrols MFA.');
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
