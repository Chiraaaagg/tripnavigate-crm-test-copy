import 'server-only';

/**
 * Server-side export of the save-time content-safety check for Terra's save
 * actions (call before the database command; keep the typed input on refusal).
 */
export { checkCustomerText, type CustomerTextCheck } from '../customer-text';
