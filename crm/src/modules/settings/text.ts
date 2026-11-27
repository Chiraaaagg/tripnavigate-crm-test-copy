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
  // R1: the frame's approval line moved to the Overview (SETTINGS_AREA_LINE.overview in contracts.ts) and into each change dialog.
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
  // R1, owner answer D9: the reason may be left empty ("No reason given" is saved); change, person and time stay recorded.
  resultChangedNoReason: '{switch} is now {state}. Recorded with your name and the time (no reason given).',
  recordedWithReason: 'Recorded with your name and reason.',
  recordedNoReason: 'Recorded with your name and the time (no reason given).',
  reasonOptionalLabel: 'Reason',
  reasonOptionalHint: 'Leave it empty, or write 10 to 500 characters. The change, your name and the time are kept either way. If the owner approved it, write that here.',
  reasonRequiredHint: '10 to 500 characters, saved with your name. Write the owner’s APPROVE here.',
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
  autoSync: 'Automatic updates from Bitrix',
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
  accounts: 'Staff notices, customer documents and refunds switches, Tally export, Tally ledger mapping and who owns Tally exceptions.',
  bitrix: 'How the CRM reads from Bitrix: status, which deals and leads come in, and the Bitrix switches.',
  imports: 'Hotels, customers and suppliers from a CSV file: check first, then import.',
  features: 'Switch CRM features on or off for every branch.',
  health: 'Bookings, PDFs, email alerts and Bitrix updates at a glance. Read only.',
} as const;

/**
 * S11 "files to Bitrix" (hosting-migration file 14 sections 2.5 to 2.7):
 * Settings › Bitrix connection, "Files kept in Bitrix" (Super Admin only) and
 * its alert list on Clean-up. Plain strings only; `{x}` = runtime value,
 * filled in modules/settings/file-move-rows.ts. Codes from the database are
 * never shown as they are: each has a short sentence here.
 */
export const FILE_MOVE_TEXT = {
  sectionTitle: 'Files kept in Bitrix',
  sectionLine: 'ID papers and, after a wait, Accounts papers are copied to the Bitrix deal, checked against the CRM’s own file, and only then deleted from the CRM. Staff keep opening them from the CRM as before. The CRM never deletes, renames or replaces anything in Bitrix.',
  notInstalled: 'Moving files to Bitrix is not installed in this CRM yet. Nothing is copied, moved or deleted.',
  readFailed: 'The CRM could not read these settings, so nothing here is shown as on or off. Nothing was changed. Reload the page; if it keeps happening, tell the CRM team.',
  approval: 'Changing this in the live CRM needs the owner’s APPROVE first. Write it in the reason.',
  affected: 'Every branch.',
  reasonHint: '10 to 500 characters, saved with your name. Write the owner’s APPROVE here.',
  updated: 'These settings were last changed on {at}.',
  updatedNever: 'These settings have not been changed since they were installed.',
  listingOff: 'New uploads are not being listed for moving right now (the CRM team stopped the listing). Nothing new is copied.',
  openStopsLine: '{n} automatic {stops} still open. Deleting cannot be switched on until each one is acknowledged on the Clean-up tab.',
  // The three switches
  checkIdTitle: 'Check ID proof copies in Bitrix',
  checkIdDetail: 'Copies visa applicants’ identity papers to the deal’s “Aadhar and Passports” box and checks every ID proof copy against the CRM’s file. Traveller ID proofs are still sent by “Copy ID proofs to the Bitrix deal”. This switch deletes nothing.',
  checkIdOn: 'Visa applicants’ identity papers start being copied to the Bitrix deal, and every ID proof copy is checked against the CRM’s file. This writes to Bitrix: it only adds files.',
  checkIdOff: 'No new copy or check starts. Files already in Bitrix stay there. “Copy ID proofs to the Bitrix deal” keeps working as before.',
  accountsTitle: 'Move Accounts files after 90 days',
  accountsDetail: 'Accounts papers stay in the CRM for {days} days after they are stored, then are copied to the deal’s Accounts box in Bitrix and checked. This switch deletes nothing.',
  accountsOn: 'Accounts papers older than {days} days start being copied to the Accounts box ({box}) and checked. This writes to Bitrix: it only adds files.',
  accountsOnNoBox: 'Accounts papers older than {days} days can be copied once the Accounts box is set. The Accounts box is not set yet, so nothing moves until it is.',
  accountsOff: 'Accounts papers wait in the CRM. Files already in Bitrix stay there.',
  deleteTitle: 'Delete the CRM’s copy after the hold',
  deleteDetail: 'After two matching checks, the second at least {minutes} minutes after the first, the CRM’s copy is deleted and the file opens from Bitrix. Nothing is ever deleted in Bitrix.',
  deleteOnPilot: 'The CRM’s copy starts being deleted for Bitrix deal {deal} only, after two matching checks and the {minutes}-minute hold. Staff then open those files from Bitrix through the CRM.',
  deleteOnAll: 'The CRM’s copy starts being deleted for every deal, company-wide, after two matching checks and the {minutes}-minute hold. Staff then open those files from Bitrix through the CRM.',
  deleteOff: 'Nothing more is deleted from the CRM. Files already deleted keep opening from Bitrix through the CRM.',
  deleteNeedsPilot: 'Set the pilot deal first: the first time, deleting can start on one pilot deal only.',
  deleteNeedsAck: 'Acknowledge the open automatic stops on the Clean-up tab first.',
  // Turning a switch off (review 14a open question 6): a ready-made reason, so stopping is never slowed down.
  emergencyReason: 'Emergency stop by Super Admin',
  emergencyUse: 'Use the reason “Emergency stop by Super Admin”',
  emergencyHint: 'To stop at once, use the ready-made reason with one click, or write your own.',
  // Owner, 28 November 2026: an emergency Off may be done at once and reported afterwards; On needs APPROVE.
  approvalOff: 'Switching Off is always allowed at once. Tell the owner afterwards. Switching On needs the owner’s APPROVE first.',
  // The values
  holdTitle: 'Hold before deleting',
  holdDetail: 'How long the CRM waits after the first matching check before it checks again and deletes its copy.',
  holdValue: '{minutes} minutes',
  holdLabel: 'Minutes to wait',
  holdHint: 'A whole number of minutes, at least 15 and at most 43200 (30 days).',
  holdEffect: 'The CRM waits this long after the first matching check before the second check and the delete. Files already waiting keep the hold they were given.',
  holdConfirm: 'Save the hold',
  holdError: 'Write a whole number of minutes from 15 to 43200.',
  boxTitle: 'Accounts box in Bitrix',
  boxDetail: 'The Deal file field the owner created in Bitrix, named “Accounts papers”. Accounts papers are copied there after {days} days.',
  boxNotSet: 'Not set',
  boxLabel: 'Item key of the “Accounts papers” field',
  boxHint: 'The Deal file field the owner created, named “Accounts papers”. Its item key starts with ufCrm_, for example ufCrm_1790000000. It cannot be the “Aadhar and Passports” field.',
  boxEffect: 'Accounts papers moved from now on are copied to this Bitrix field. The CRM never creates or changes the field itself.',
  boxConfirm: 'Save the Accounts box',
  boxError: 'Write the item key of the “Accounts papers” field: ufCrm_ followed by up to 40 letters, digits or underscores. It cannot be the “Aadhar and Passports” field.',
  boxSameAsId: 'This is the “Aadhar and Passports” field. Write the item key of the “Accounts papers” field.',
  pilotTitle: 'Pilot deal for deleting',
  pilotDetail: 'While a pilot deal is set, deleting the CRM’s copy applies to that one Bitrix deal only.',
  pilotValue: 'Bitrix deal {deal}',
  pilotNone: 'None set',
  pilotNoneAll: 'None: deleting applies to every deal',
  pilotLabel: 'Bitrix deal number',
  pilotHint: 'The number of the test deal in Bitrix, digits only.',
  pilotEffect: 'Deleting the CRM’s copy applies to Bitrix deal {deal} only while “Delete the CRM’s copy after the hold” is on.',
  pilotEffectNew: 'Deleting the CRM’s copy applies to the Bitrix deal you write below only, while “Delete the CRM’s copy after the hold” is on.',
  pilotConfirm: 'Save the pilot deal',
  pilotError: 'Write the Bitrix deal number, digits only.',
  clearTitle: 'Clear the pilot deal',
  clearEffect: 'Clearing the pilot is the company-wide start. With “Delete the CRM’s copy after the hold” on, the CRM’s copy of every deal’s moved files is then deleted after the checks and the hold, not only Bitrix deal {deal}.',
  clearEffectOff: 'Clearing the pilot is the company-wide start. When “Delete the CRM’s copy after the hold” is switched on, the CRM’s copy of every deal’s moved files will be deleted after the checks and the hold.',
  clearConfirm: 'Clear the pilot: start company-wide',
  // Results
  savedSwitch: '{switch} is now {state}. Recorded with your name and reason.',
  unchangedSwitch: '{switch} was already {state}. Nothing changed.',
  savedHold: 'The hold is now {minutes} minutes. Recorded with your name and reason.',
  savedBox: 'The Accounts box is now {box}. Recorded with your name and reason.',
  savedPilot: 'The pilot deal is now Bitrix deal {deal}. Recorded with your name and reason.',
  savedPilotCleared: 'The pilot deal is cleared: deleting is no longer limited to one deal. Recorded with your name and reason.',
  unchanged: 'That was already the setting. Nothing changed.',
  savedAck: 'The stop is acknowledged. Recorded with your name and reason.',
  savedRetry: 'Trying again. The CRM reads Bitrix first and never sends a file twice blindly.',
  savedRelocate: 'The CRM will look for the file in Bitrix deal {deal}, by its content.',
  savedLost: 'Recorded: this file is accepted as lost. Other files of the deal can move again.',
  // Refusals (the database decides; these are its codes in plain words)
  refusedReason: 'Not saved: say why, in 10 to 500 characters.',
  refusedReview: 'Not saved: review the change first. Nothing was changed.',
  refusedNotAuthorized: 'Only the Super Admin can change this. Nothing was changed.',
  refusedNotInstalled: 'Moving files to Bitrix is not installed in this CRM yet. Nothing was changed.',
  refusedPilotRequired: 'Not switched on: the first time, deleting can start on one pilot deal only. Set the pilot deal first. Nothing was changed.',
  refusedOpenStops: 'Not switched on: an automatic stop is still open. Acknowledge it on the Clean-up tab first. Nothing was changed.',
  refusedWrongState: 'This cannot be done right now, in the present state of the file or setting. Nothing was changed. Reload the page to see the latest.',
  refusedInput: 'Check the value marked below. Nothing was changed.',
  refusedNotFound: 'This item is no longer there. Nothing was changed. Reload the page.',
  refusedConflict: 'Something else changed this at the same moment. Nothing was changed. Try again in a minute.',
  refusedViewLimit: 'Too many files were opened from Bitrix in the last minute. Wait a minute and try again.',
  // Alerts (Clean-up)
  alertsTitle: 'Files kept in Bitrix: alerts',
  alertsLine: 'Automatic stops, and files that need a person. Codes, deal numbers and times only: no file names.',
  alertsReadFailed: 'The alerts could not be read. Nothing is assumed. Reload the page.',
  alertsNothing: 'Nothing open',
  alertsCount: '{stops} open {stopsWord} · {items} {itemsWord} to check',
  stopsTitle: 'Automatic stops',
  stopsNone: 'No automatic stop.',
  stopsHelp: 'An automatic stop switched deleting off. Read what happened, then acknowledge it with a reason. Deleting can be switched on again only when no stop is open.',
  stopOpen: 'Open',
  stopAcknowledged: 'Acknowledged',
  stopOpened: 'Stopped on {at}',
  stopAckAt: 'acknowledged on {at}',
  ackLabel: 'Acknowledge',
  ackTitle: 'Acknowledge this stop?',
  ackEffect: 'The stop is closed with your name and reason. It does not switch anything on: deleting stays off until someone switches it on with the owner’s APPROVE.',
  ackConfirm: 'Acknowledge the stop',
  itemsTitle: 'Files that need a person',
  itemsNone: 'No file needs a person.',
  itemDeal: 'Bitrix deal {deal}',
  itemNoDeal: 'No Bitrix deal',
  itemUpdated: 'Last change {at}',
  itemLastError: 'Last problem: {error}.',
  retryLabel: 'Try again',
  retryTitle: 'Try this file again?',
  retryEffect: 'The CRM first reads the Bitrix deal to see what is already there; it never sends the file again blindly. Nothing is deleted by this.',
  retryConfirm: 'Try again',
  relocateLabel: 'Look in another deal',
  relocateTitle: 'Look for this file in another Bitrix deal?',
  relocateEffect: 'Use this when the deal was merged in Bitrix. The CRM searches that deal’s box for a file with exactly the same content and changes nothing in Bitrix.',
  relocateLabelField: 'Bitrix deal number to search',
  relocateHint: 'The number of the deal it was merged into, digits only.',
  relocateConfirm: 'Search that deal',
  lostLabel: 'Accept this file is lost',
  lostTitle: 'Accept this file is lost?',
  lostEffect: 'Use this only when the file cannot be found in Bitrix and the CRM no longer has it. The file stays recorded as lost, with your name and reason. Other files of the same deal can then move again.',
  lostConfirm: 'Accept this file is lost',
  countNoTarget: 'Files with no Bitrix deal, staying in the CRM: {n}.',
  countMissed: 'Uploads listed late by the 10-minute check: {n}.',
  countWaiting: 'Accounts files waiting for their {days} days in the CRM: {n}.',
  countSole: 'Files kept only in Bitrix now (the CRM’s copy was deleted after the checks): {n}.',
  countOrphaned: 'File records whose CRM deal no longer exists (they are skipped by every check; tell the lead): {n}.',
} as const;

/** Stop reasons (file_move_stops.reason_code) in plain words. */
export const FILE_MOVE_STOP_WORDS: Record<string, string> = {
  prior_files_lost: 'A file that was already in the Bitrix deal went missing after a copy. Deleting was switched off.',
  copy_mismatch: 'A Bitrix copy did not match the CRM’s file. It is never shown from Bitrix. Deleting was switched off.',
  missing_in_bitrix: 'A file was not found in the Bitrix deal, and a search by its content found nothing. Deleting was switched off.',
  deal_not_found: 'Bitrix could not find this deal. Nothing was deleted or sent again.',
  deal_removed_with_files: 'This deal left the CRM while Bitrix held the only copy of some of its files.',
  view_unreadable: 'Bitrix gave no usable download for a file someone tried to open. The file was not shown. Nothing was deleted, and deleting stays as it was.',
};

/** Alert item kinds (file_move_alerts().items[].kind) in plain words. */
export const FILE_MOVE_ITEM_WORDS: Record<string, { label: string; text: string }> = {
  quarantined: { label: 'Copy does not match', text: 'The Bitrix copy did not match the CRM’s file. It is never shown from Bitrix and nothing more is deleted.' },
  needs_manual_check: { label: 'Needs a check', text: 'Bitrix did not give a clear answer after five tries. Try again reads Bitrix first.' },
  lost_in_bitrix: { label: 'Lost in Bitrix', text: 'The file is no longer in the Bitrix deal and a search by its content found nothing. Other files of this deal wait.' },
  failed: { label: 'Move stopped', text: 'The move stopped with a problem. Try again reads Bitrix first.' },
  stuck: { label: 'Waiting too long', text: 'This file has waited more than a day to be copied.' },
  blocked_by_lost_file: { label: 'Waiting for a lost file', text: 'Waiting for a lost file on the same deal. This file is still in the CRM.' },
  deletion_waiting: { label: 'Deleting waits', text: 'Deleting waits for a copy to the same deal to settle. Nothing is lost.' },
};

/** Move states (file_bitrix_moves.state) in plain words. */
export const FILE_MOVE_STATE_WORDS: Record<string, string> = {
  no_target: 'No Bitrix deal: stays in the CRM',
  waiting: 'Waiting',
  copy_pending: 'Waiting to be copied',
  copy_sending: 'Being copied',
  copy_unknown: 'Copy not confirmed yet',
  copied: 'Copied, not checked yet',
  verified: 'Checked once, in the CRM too',
  delete_pending: 'About to be deleted from the CRM',
  deleted: 'Only in Bitrix',
  restore_pending: 'Being copied back to the CRM',
  quarantined: 'Copy does not match',
  needs_manual_check: 'Needs a check',
  failed: 'Move stopped',
  lost_in_bitrix: 'Lost in Bitrix',
  lost_accepted: 'Accepted as lost',
  cancelled: 'Cancelled',
};

/** Which kind of paper (file_bitrix_moves.file_class and source table). */
export const FILE_MOVE_CLASS_WORDS: Record<string, string> = { id_proof: 'ID paper', accounts: 'Accounts paper' };
export const FILE_MOVE_SOURCE_WORDS: Record<string, string> = {
  traveller_id_proofs: 'Traveller ID proof',
  department_evidence: 'Visa or department paper',
  customer_party_documents: 'Customer paper',
  finance_evidence: 'Customer payment paper',
  refund_evidence: 'Refund proof',
  supplier_money_evidence: 'Supplier payment paper',
  booking_evidence: 'Booking paper',
};
