import type { BitrixSwitchKey } from '@/modules/access/settings-state';
import type { WorkflowSettingKey } from '@/modules/fulfilment/contracts';

/*
 * Batch 4 Settings wording (copy-catalogue §16.13, DA-250 to DA-264; Mercury
 * 23 October 2026). Plain strings only, no logic. `{x}` = runtime value,
 * filled by the builders in rows.ts and sync-scope.ts.
 */

export const SETTINGS_TEXT = {
  // DA-251
  title: 'Settings',
  frameLine: 'Changes here affect every branch. Live changes need the owner’s APPROVE first; write it in the reason.',
  frameReadOnly: 'You can view these settings but not change them.',
  // DA-253
  readOnlyLine: 'Changed by the CRM team with the owner’s approval, not here.',
  // DA-254
  lastPerson: 'Last changed on {at} by {name}{switched}.',
  lastSystem: 'Last changed on {at} by a system update (no person recorded){switched}.',
  lastReason: 'Reason: “{reason}”',
  lastNone: 'No change recorded since change tracking started.',
  lastUnknown: 'Last change: could not be read.',
  // DA-255
  unknownOne: 'The CRM could not read this setting, so it shows as Unknown. Unknown is not Off. It cannot be changed until the CRM can read it. Reload the page; if it stays Unknown, tell the CRM team.',
  unknownSection: 'The CRM could not read these settings, so every switch here shows as Unknown. Nothing is assumed on or off. Reload the page; if it stays Unknown, tell the CRM team.',
  notInstalled: 'These settings are not installed in this CRM yet. Nothing is assumed on or off.',
  // DA-256
  changeButton: 'Change {switch}',
  setItTo: 'Set it to',
  itIsOn: 'It is on now.',
  itIsOff: 'It is off now.',
  reasonLabel: 'Why are you changing it?',
  reasonHint: '10 to 500 characters, saved with your name. Write the owner’s APPROVE here.',
  reviewButton: 'Review change',
  reviewTitle: 'Review: turn {switch} {state}',
  reviewApproval: 'Changing this in the live CRM needs the owner’s APPROVE first. Write it in the reason.',
  scopeLine: 'This changes which deals or leads are in the CRM for everyone.',
  confirmButton: 'Turn {switch} {state}',
  goBack: 'Go back',
  pending: 'Saving…',
  resultChanged: '{switch} is now {state}. Recorded with your name and reason.',
  resultUnchanged: '{switch} was already {state}. Nothing changed.',
  refusedReason: 'Not saved: say why, in 10 to 500 characters.',
  refusedReview: 'Not saved: review the change first. Nothing was changed.',
  refusedNotAuthorized: 'Only a Super Admin can change this. Nothing was changed.',
  onlySuperAdmin: 'Only a Super Admin can change this.',
  refusedNotConfigured: 'The Bitrix connection is not set up, so this setting cannot be changed. Nothing was changed.',
  refusedNotInstalled: 'This setting is not installed in this CRM yet. Nothing was changed.',
  // DA-237
  // DA-293
  busy: 'These settings are busy right now. Nothing was changed. Try again in a minute.',
  // G-06, G-05
  signedOut: 'You were signed out. Sign in again; what you typed is still on this page.',
  unknownOutcome: 'We could not confirm this was saved. Reload the page to check before you try again. Your typed details are still here.',
  // DA-258
  visaCounting: 'Counting the visa and passport services waiting…',
  visaCount: 'Switching on now creates {n} Visa and passport {tasks} on {deals} {dealsWord}, one for each sold service that has no task yet.',
  visaCountZero: 'Switching on now creates no tasks: no sold visa or passport service is waiting.',
  visaSkipped: '{skipped} services on removed or lost deals get no task.',
  visaUncounted: 'The CRM could not count the waiting services, so this cannot be switched on now. Nothing was changed. Reload the page to try again.',
  visaResult: 'Visa and passport tasks are on. {n} tasks were created.',
  visaResultDiffers: '{n} tasks were created ({m} were counted in the review; services changed in between).',
  visaOff: 'Switching off creates and deletes nothing. Tasks already made stay with the desk. New visa and passport services wait without a task.',
  // DA-257 dependency line
  fillNeedsRead: '“Read trip facts from Bitrix” is {state}, so nothing is filled until it is on.',
  idProofOpenStops: 'Switching on also closes {n} open automatic stops with your reason.',
  // Features page link to the switches shown on Bitrix connection (lead ruling D3)
  bitrixSwitchesElsewhere: 'The Bitrix switches, ID-proof copies and “Bring in deals only when won” are on the Bitrix connection tab.',
} as const;

export interface SwitchWords {
  /** Plain name, also used in APPROVAL NEEDED messages (DA-257). */
  title: string;
  /** Detail paragraph shown next to the decision; absent = the switch's detail in WORKFLOW_SETTING_LABEL / B12_SWITCH_TEXT. */
  detail?: string;
  /** Effect lines in the review step. */
  on: string;
  off: string;
  /** Sync-scope switches (R6, DEC-37): the review adds SETTINGS_TEXT.scopeLine. */
  scope?: true;
}

/**
 * DA-257 / DA-258 / DA-239 / DA-172 / DA-174 / DA-141 per switch. The detail
 * paragraphs of Referral drafts, Fill from Bitrix and Read trip facts stay in
 * WORKFLOW_SETTING_LABEL / B12_SWITCH_TEXT (DA-239, DA-172, DA-174); titles here equal theirs.
 */
export const SWITCH_WORDS: Record<WorkflowSettingKey | BitrixSwitchKey, SwitchWords> = {
  service_items_enabled: {
    title: 'Book now (service list)',
    detail: 'New bookings list each sold service; submitting creates one task per service.',
    on: 'New bookings list each sold service; submitting creates one task per service.',
    off: 'New bookings use the older single hotel booking. Bookings and tasks already made stay readable.',
  },
  intake_prompt_enabled: {
    title: 'Count of won deals with no booking (on Home)',
    detail: 'Sales and branch Managers see on Home how many deals reached “Won - Payment Received” in Bitrix but have no booking yet. Count only; nothing is created.',
    on: 'Sales and branch Managers see on Home how many deals reached “Won - Payment Received” in Bitrix but have no booking yet. Count only; nothing is created.',
    off: 'The count is hidden. Nothing else changes.',
  },
  visa_passport_tasks_enabled: {
    title: 'Visa and passport tasks',
    detail: 'On: each sold visa or passport service gets one task for the Visa and passport desk. Off: those services are saved and wait; no task is created or deleted.',
    on: 'Each sold visa or passport service gets one task for the Visa and passport desk.',
    off: 'Switching off creates and deletes nothing. Tasks already made stay with the desk. New visa and passport services wait without a task.',
  },
  referral_drafts: {
    title: 'Referral drafts',
    on: 'Sales and branch Managers can start quotations and itineraries for customers not in Bitrix yet. A draft with no changes for 90 days (India time) closes on its own, unless a quotation from it is already tied to a deal; it stays readable and can be reopened. Turning it on again starts the 90 days again for every open draft.',
    off: 'No new referral drafts, and nothing closes on its own; existing drafts keep working (change, link, close, reopen). The Quotations and Itineraries lists work either way.',
  },
  prefill_auto_fill: {
    title: 'Fill new bookings and quotations from Bitrix',
    on: 'When staff start a booking or create a quotation, empty fields get the Bitrix dates and contact details once, marked “From Bitrix”. Billing, GSTIN, ID consent and the contact check are never filled.',
    off: 'Staff use the “Use Bitrix value” buttons as before. Values already filled stay.',
  },
  bitrix_trip_facts_read: {
    title: 'Read trip facts from Bitrix',
    on: 'Reads Bitrix trip facts from now on. Nothing is written to Bitrix.',
    off: 'Stops reading Bitrix trip facts. “Fill new bookings and quotations from Bitrix” then fills nothing. Values already in bookings and quotations stay.',
  },
  lead_intake_unowned: {
    title: 'Bring in leads whose Bitrix owner is not a CRM salesperson',
    detail: 'Leads whose Bitrix owner is not a CRM salesperson come into the CRM and wait for an owner. Off: they are skipped.',
    on: 'Brings in the leads skipped so far at the next Bitrix update. This changes which leads are in the CRM.',
    off: 'New leads without a CRM salesperson are skipped again. Leads already in the CRM stay.',
    scope: true,
  },
  bitrix_id_proof_copy: {
    title: 'Copy ID proofs to the Bitrix deal',
    detail: 'Adds each ID proof stored from now on to the “Aadhar and Passports” field of the linked Bitrix deal. It only adds files; it never deletes or replaces files in Bitrix. Proofs stored earlier are not copied.',
    on: 'This is the only setting that writes to Bitrix.',
    off: 'Nothing more is sent to Bitrix. Files already there stay.',
  },
  bitrix_name_read: {
    title: 'Bitrix names',
    detail: 'Shows Bitrix stage, status and source names. Read-only; nothing is written to Bitrix.',
    on: 'Shows Bitrix stage, status and source names after the next daily read. Nothing is written to Bitrix.',
    off: 'Screens show the codes again; stored names are kept.',
  },
  won_only_intake: {
    title: 'Bring in deals only when won',
    detail: 'New Bitrix deals come into the CRM only when they reach “Won - Payment Received”. Deals already in the CRM stay and keep updating.',
    on: 'New Bitrix deals come into the CRM only when they reach “Won - Payment Received”. Deals already in the CRM stay and keep updating.',
    off: 'New deals come in from the ticked stages again.',
    scope: true,
  },
};

/** DA-253 / DA-262 / DA-264 read-only rows. */
export const READ_ONLY_WORDS = {
  real_booking: { title: 'Real bookings', unknown: 'Unknown' },
  supplier_confirmation: { title: 'Supplier confirmation' },
  pdf_render_online: { title: 'Online PDF maker', line: 'Changed in the hosting settings with the owner’s approval, not here.' },
  finance_mode: { available: 'Available', notAvailable: 'Not available yet', companyAccounts: 'Company accounts are managed in Accounts → Company accounts.' },
} as const;

/** DA-259: which deals come in from Bitrix. */
export const SYNC_SCOPE_TEXT = {
  section: 'Which deals come in from Bitrix',
  untickWarning: 'Unticking a stage or pipeline hides its deals from everyone in the CRM. Hidden deals are kept and come back if you tick it again.',
  dateLabel: 'Bring in deals created on or after',
  dateHint: 'Uses the Bitrix creation date, from 00:00 India time. Moving this date later hides older deals from everyone; moving it earlier brings them back.',
  autoSync: 'Automatic updates from Bitrix (every 30 seconds)',
  reviewButton: 'Review changes',
  counting: 'Counting the deals…',
  reviewTitle: 'Review: which deals come in from Bitrix',
  pipelinesAdded: 'Pipelines added: {list}',
  pipelinesRemoved: 'Pipelines removed: {list}',
  stagesAdded: 'Stages added: {list}',
  stagesRemoved: 'Stages removed: {list}',
  dateChange: 'Bring in deals created on or after: changes from {old} to {new}',
  autoSyncChange: 'Automatic updates: switched {state}',
  hides: 'Hides {n} deals from everyone now.',
  hidesBreakdown: '{beforeSyncDate} created before the date · {pipelineNotEligible} in a pipeline no longer ticked · {stageNotEligible} in a stage no longer ticked',
  withCrmWork: '{n} of them have CRM work (a booking, task, payment record or document). Their records are kept and come back with the deal.',
  bringsBack: 'Brings back {n} hidden deals.',
  nothing: 'No deal is hidden or brought back now.',
  recheck: 'Bitrix is checked again for {n} skipped records. Some may come in at the next update; this number is not exact.',
  onlyAutoSync: 'Only automatic updates change. No deal is hidden or brought back.',
  approval: 'This changes which deals are in the CRM for everyone. Get the owner’s APPROVE first and write it in the reason.',
  validFor: 'This review is valid for 10 minutes.',
  confirmHide: 'Save and hide {n} deals',
  confirm: 'Save settings',
  back: 'Go back and change',
  saved: 'Saved. {hidden} deals hidden and {broughtBack} brought back. Recorded with your name and reason.',
  savedNothing: 'Saved. No deal was hidden or brought back.',
  lastSaved: 'Last saved on {at} by {name}.',
  lastSavedCounts: 'Hid {hidden} and brought back {broughtBack} deals.',
  refused: {
    preview_required: 'Not saved: review the change first. Nothing was changed.',
    preview_used: 'This change was already saved. Reload the page to see it.',
    expired: 'Not saved: the review is older than 10 minutes. Review the change again.',
    settings_changed: 'Not saved: someone changed these settings after your review. Review the change again.',
    // Lead ruling 23 Oct: back to the review with a fresh preview, so the new numbers are below.
    counts_changed: 'Not saved: the numbers changed after your review. Check the new numbers below and confirm again.',
    preview_stale: 'Not saved: the review is out of date. Review the change again.',
    settings_busy: 'The Bitrix settings are busy right now. Nothing was changed. Try again in a minute.',
    invalid_reason: 'Not saved: say why, in 10 to 500 characters.',
    not_authorized: 'Only staff who manage the Bitrix connection can change this. Nothing was changed.',
    not_configured: 'The Bitrix connection is not set up, so these settings cannot be changed. Nothing was changed.',
    not_installed: 'Reviewing these changes is not installed in this CRM yet, so they cannot be saved now. Nothing was changed.',
    invalid_input: 'Check the settings marked below. Nothing was changed.',
    session: 'You were signed out. Sign in again; what you typed is still on this page.',
    unexpected: 'We could not confirm this was saved. Reload the page to check before you try again. Your typed details are still here.',
  },
  fieldError: {
    categoryIds: 'Choose at least one pipeline.',
    stageIds: 'Choose at least one stage.',
    cutoff: 'The start date must be in the past.',
    syncEnabled: 'Choose whether automatic updates are on.',
    // DA-293
    entryStagePipeline: '“Bring in deals only when won” takes new deals from a stage in a pipeline you unticked. Keep that pipeline ticked, or switch it off first.',
  },
} as const;

/** DA-261: Company and branches. */
export const COMPANY_TEXT = {
  title: 'Company and branches',
  line: 'Printed on quotations and itineraries. Read only: these details change only through a reviewed update by the CRM team, using the details Accounts approved.',
  company: 'Company',
  address: 'Registered address',
  pan: 'PAN',
  branch: 'Branch',
  state: 'State',
  gstin: 'GSTIN',
  pilot: 'Bitrix pilot',
  gstinMissing: 'Not given yet. Final PDFs for this branch are blocked until it is added.',
  pilotYes: 'Pilot branch',
  pilotNo: '—',
  pilotUnknown: 'Not known (could not be read)',
  notApproved: '{branch} is not in the approved company details yet. Its documents print “[GSTIN for {branch}]” and the final PDF is blocked.',
  footer: 'To change these details, ask the CRM team. Accounts gives the approved details and the owner approves the change.',
  loadFailed: 'Company details did not load. Nothing was changed. Reload the page. If it keeps happening, tell the CRM team.',
  noPermission: 'Only staff with a Settings right can open this page.',
} as const;

/** DA-252 tab descriptions. */
export const SETTINGS_TAB_DESCRIPTION = {
  people: 'Staff accounts, sign-in recovery and extra access to deals.',
  company: 'Company details printed on documents, and the branches. Read only.',
  money: 'Receipt and cash limits, and which payment modes are available.',
  bitrix: 'How the CRM reads from Bitrix: status, which deals and leads come in, and the Bitrix switches.',
  imports: 'Hotel and customer lists from a CSV file: check first, then import.',
  features: 'Switch CRM features on or off for every branch.',
  health: 'Bookings, PDFs, email alerts and Bitrix updates at a glance. Read only.',
} as const;
