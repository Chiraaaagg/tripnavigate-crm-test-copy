/**
 * documents module (B1.2 Phase F groundwork): customer-document view DTOs,
 * engine adapters, content-safety scan and the factual-difference check.
 * Server-only adapters; pure helpers. See ./README.md.
 *
 * The HTML renderer (./render/html.tsx) is deliberately NOT exported here:
 * it imports react-dom/server, which cannot load in the React Server
 * Components layer. Import it directly from the render worker only.
 */
export * from './contracts';
export { forbiddenKeyPaths } from './guard';
export { exactPerPersonRupees, paiseToRupees, rupeesInWords } from './money';
export { htmlToText, scanStrings, scanText, type SafetyHit, type SafetyKind } from './safety';
export { isPlaceholder, neutraliseLeadingBracket, placeholder } from './text';
export { compareTripFacts, compareTripFactsDetailed, differenceKey, normaliseFactText, type DetailedComparison } from './facts-diff';
export { QUOTATION_PREVIEW_TEXT, quotationDayPlanNotice, quotationToEngineQuote } from './quotation-adapter';
export { itineraryToEngine } from './itinerary-adapter';
export { checkCustomerText, type CustomerTextCheck } from './customer-text';
export { CustomerMoneySchema, QuotationGetSchema, toCustomerTiers, toQuotationDocumentView } from './quotation-view';
export { ItineraryDocumentGetSchema, basisFactsFromBooking, basisFactsFromQuotation, toAtlasFactsJson, toItineraryDocumentView, toItineraryFactsDraft } from './itinerary-view';
export { DIFFERENCE_PATH } from './facts-diff';
