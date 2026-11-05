/**
 * fulfilment module: booking version → Purchase hotel task (Phase 3); B1 adds
 * service items, travellers, the intake checklist, Deal progress, My work
 * counts and the Flight queue.
 *
 * This entry point is CLIENT-SAFE: frozen contracts, DTO helpers and form
 * field names only. Server code is imported by path:
 *   - '@/modules/fulfilment/server/actions'          (booking server actions, 'use server')
 *   - '@/modules/fulfilment/server/queries'          (booking page loaders, server-only)
 *   - '@/modules/fulfilment/server/intake'           (B1 loaders: intake, Deal services, summaries, switches)
 *   - '@/modules/fulfilment/server/intake-actions'   (B1 intake server actions)
 *   - '@/modules/fulfilment/server/flight'           (B1 Flight queue loaders)
 *   - '@/modules/fulfilment/server/flight-actions'   (B1 Flight claim action)
 *   - '@/modules/fulfilment/server/counts'           (B1 My work counts)
 *   - '@/modules/fulfilment/server/workflow-actions' (B1 workflow switch action)
 *   - '@/modules/fulfilment/server/book-now'         (B1.1 loadBookNow)
 *   - '@/modules/fulfilment/server/book-now-actions' (B1.1 Book now, submit and revision actions)
 *   - '@/modules/fulfilment/server/visa'             (B1.1 Visa & Passport desk loaders)
 *   - '@/modules/fulfilment/server/visa-actions'     (B1.1 desk actions)
 *   - '@/modules/fulfilment/server/department'       (B1.1 department work form loader)
 *   - '@/modules/fulfilment/server/department-actions' (B1.1 cost entries and department files)
 *   - '@/modules/fulfilment/server/department-evidence' (B1.1 department file download handler)
 * See ./README.md ("API for agent C").
 */
export * from './contracts';
export { checklistText, computeProgress, formatEvidenceSize, itemTitle, nextStepFor, nightsBetween } from './dto';
export {
  FIELD as BOOKING_FORM_FIELDS,
  paiseToRupeesInput,
  parseServiceItemForm,
  parseTravellersForm,
  parseWorkflowSettingForm,
  rupeesToPaise,
  validateServiceFacts,
  WORKFLOW_REASON_LIMITS,
} from './forms';
// B1.1 pure helpers (client-safe).
export { bookStepStatus, documentLabel, identityRequiredSeqs, mergeBookChecklist } from './b11-dto';
export { expectedTotalPaise, istLocalToIso, normaliseIndianMobile, planTotalPaise } from './b11-forms';
