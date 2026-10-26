/*
 * The page error summary's order rule lives in Terra's pure flow module
 * (unsaved, refused, blocking, skipped; page order inside a kind; the same
 * message for the same part once). Re-exported for the view components.
 */
export { orderSummaryItems } from '@/modules/fulfilment/book-flow';
