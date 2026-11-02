/**
 * finance module (Phase 5A: Accounts review and customer receipts).
 * Client-safe exports only: shared contract types and wording, response
 * schemas, typed RPC wrappers and pure form parsing. Server code lives in
 * ./server (queries, actions, evidence) and is imported from there directly.
 */
export * from './contracts';
export * from './commands';
export * from './dto';
export * from './forms';
