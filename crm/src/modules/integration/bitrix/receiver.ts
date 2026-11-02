import 'server-only';
import type { IntegrationEnv } from '@/lib/config';
import { IntakeCommandError, recordBitrixEvent, type RecordedEvent, type RpcClient } from '../commands';
import { selectActiveConfig, type IntakeConfig } from '../intake-config';
import { checkApplicationToken, checkPortal } from './auth';
import { MAX_EVENT_BODY_BYTES, parseFormBody, readBitrixEvent, readEventAuth } from './events';

/**
 * POST /api/integrations/bitrix/events (contract §6).
 *
 *   503  receiver not configured (no token env, no enabled config, DB refusal)
 *   413  body larger than 16 KiB
 *   400  not x-www-form-urlencoded, malformed, > 64 fields, unknown event, bad IDs
 *        (accepted events: ONCRMDEALADD/UPDATE and, Phase 6, ONCRMLEADADD/UPDATE)
 *   401  missing auth, wrong application_token, wrong member_id/domain
 *   200  only after integration_record_bitrix_event committed (new or duplicate).
 *        Phase 6: a record outside the active manifest is still acknowledged with
 *        the same 200 body; the database stores it as `ignored / not_in_manifest`.
 *
 * The event is never processed inline. Responses are minimal JSON and never echo
 * input. Nothing is logged except fixed outcome codes.
 *
 * Sync completion §1: after a committed record, `afterRecord` may schedule a
 * bounded live batch (Next.js `after()`, see ./live.ts). It is called only on
 * the 200 path, must not await the batch, and anything it throws is ignored:
 * the response is the same with or without it.
 */

export interface ReceiverDeps {
  env: IntegrationEnv;
  /** Rows of integration_intake_config for source_system='bitrix' (service role). */
  loadConfigRows: () => Promise<unknown[]>;
  rpc: () => RpcClient;
  /** Called once after a committed record, before the 200 answer; must only schedule work. */
  afterRecord?: (recorded: RecordedEvent, config: IntakeConfig) => void;
}

const HEADERS = { 'cache-control': 'no-store', 'content-type': 'application/json' } as const;

export function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

type BodyRead = { ok: true; text: string } | { ok: false; status: 400 | 413 };

/** Reads at most `limit` bytes; anything larger is refused without buffering it. */
export async function readBoundedText(request: Request, limit: number): Promise<BodyRead> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    if (!/^\d{1,12}$/.test(declared)) return { ok: false, status: 400 };
    if (Number(declared) > limit) return { ok: false, status: 413 };
  }
  const reader = request.body?.getReader();
  if (!reader) return { ok: false, status: 400 };
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, status: 413 };
    }
    chunks.push(value);
  }
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) };
  } catch {
    return { ok: false, status: 400 };
  }
}

export async function handleBitrixEvent(request: Request, deps: ReceiverDeps): Promise<Response> {
  const expectedToken = deps.env.bitrixEventApplicationToken;
  if (!expectedToken) return json(503, { error: 'not_configured' });

  const contentType = (request.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.startsWith('application/x-www-form-urlencoded')) return json(400, { error: 'invalid_request' });

  const body = await readBoundedText(request, MAX_EVENT_BODY_BYTES);
  if (!body.ok) return json(body.status, { error: body.status === 413 ? 'payload_too_large' : 'invalid_request' });

  const form = parseFormBody(body.text);
  if (!form.ok) return json(400, { error: 'invalid_request' });

  // 1. Token first, before any database read.
  const auth = readEventAuth(form.fields);
  if (checkApplicationToken(auth, expectedToken) !== 'ok') return json(401, { error: 'unauthorized' });

  // 2. Portal identity from configuration, never from the caller.
  let rows: unknown[];
  try {
    rows = await deps.loadConfigRows();
  } catch {
    return json(503, { error: 'unavailable' });
  }
  const active = selectActiveConfig(rows);
  if (!active.config) return json(503, { error: 'not_configured' });
  if (checkPortal(auth, active.config) !== 'ok') return json(401, { error: 'unauthorized' });

  // 3. Strict event shape: Deal (ONCRMDEAL*) or Lead (ONCRMLEAD*) events only.
  const event = readBitrixEvent(form.fields);
  if (!event) return json(400, { error: 'invalid_request' });

  // 4. Durable record; acknowledge only after commit.
  let recorded: RecordedEvent;
  try {
    recorded = await recordBitrixEvent(deps.rpc(), {
      memberId: active.config.portalMemberId,
      eventType: event.event,
      sourceObject: event.sourceObject,
      sourceId: event.sourceId,
      sourceTs: event.ts,
    });
  } catch (error) {
    if (error instanceof IntakeCommandError && error.refusal === 'wrong_portal') {
      return json(401, { error: 'unauthorized' });
    }
    if (error instanceof IntakeCommandError && error.refusal) return json(503, { error: 'not_configured' });
    return json(503, { error: 'unavailable' });
  }
  // 5. Live processing is scheduled, never awaited; it cannot change this answer.
  if (deps.afterRecord) {
    try {
      deps.afterRecord(recorded, active.config);
    } catch {
      // Scheduling failed: the scheduled run picks the row up instead.
    }
  }
  return json(200, { ok: true });
}
