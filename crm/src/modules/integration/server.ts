import 'server-only';

/**
 * integration module: server-only entry. Other modules call these from
 * server code only (src/modules/README.md rule 5); they touch the database
 * and Bitrix. Client-safe exports, if any, belong in ./index.ts.
 */
export { refreshDealNow, type RefreshDealOutcome } from './server/refresh-deal';
