import {
  NOTICE_DEPARTMENTS,
  NOTICE_KINDS,
  NOTICE_LINK_KINDS,
  NOTICE_PRIORITIES,
  NOTICE_RESOLVED_REASONS,
  type NoticeHistoryDTO,
  type NoticeInboxDTO,
  type NoticeItemDTO,
  type NoticeLinkDTO,
  type NoticeParams,
} from './contracts';

/**
 * Hand-written validation of the bell reads for the BROWSER bundle (no zod:
 * zod 4 probes `new Function`, which the CSP blocks). Same checks as the
 * server schemas in dto.ts: types, enums, non-negative / positive integers,
 * nullable fields; every object is rebuilt from the known keys only, so
 * unknown keys are stripped. Any mismatch answers null (fail closed).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARAM_TEXT = /^[A-Za-z0-9 _./-]+$/;

class Invalid extends Error {}
const fail = (): never => {
  throw new Invalid();
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : fail());
const bool = (v: unknown): boolean => (typeof v === 'boolean' ? v : fail());
const int = (v: unknown, min: number): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= min ? v : fail());
const text = (v: unknown): string => (typeof v === 'string' && v.length > 0 ? v : fail());
const uuid = (v: unknown): string => (typeof v === 'string' && UUID.test(v) ? v : fail());
const nullable = <T>(v: unknown, f: (x: unknown) => T): T | null => (v === null ? null : f(v));
const oneOf = <T extends string>(list: readonly T[]) => (v: unknown): T => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : fail());
const anyString = (v: unknown): string => (typeof v === 'string' ? v : fail());

function params(v: unknown): NoticeParams {
  const o = obj(v);
  const out: NoticeParams = {};
  const ref = (x: unknown): string => (typeof x === 'string' && x.length >= 1 && x.length <= 60 && PARAM_TEXT.test(x) ? x : fail());
  if (o.dealReference !== undefined) out.dealReference = ref(o.dealReference);
  if (o.department !== undefined) out.department = oneOf(NOTICE_DEPARTMENTS)(o.department);
  if (o.refNo !== undefined) out.refNo = ref(o.refNo);
  if (o.serviceType !== undefined) out.serviceType = ref(o.serviceType);
  if (o.versionNo !== undefined) out.versionNo = int(o.versionNo, 1);
  if (o.status !== undefined) out.status = ref(o.status);
  return out;
}

function link(v: unknown): NoticeLinkDTO {
  const o = obj(v);
  return { kind: oneOf(NOTICE_LINK_KINDS)(o.kind), id: uuid(o.id) };
}

function item(v: unknown): NoticeItemDTO {
  const o = obj(v);
  return {
    noticeId: uuid(o.noticeId),
    seq: int(o.seq, 1),
    kind: oneOf(NOTICE_KINDS)(o.kind),
    priority: oneOf(NOTICE_PRIORITIES)(o.priority),
    escalated: bool(o.escalated),
    createdAt: text(o.createdAt),
    readAt: nullable(o.readAt, text),
    doneAt: nullable(o.doneAt, text),
    resolvedAt: nullable(o.resolvedAt, text),
    resolvedReason: nullable(o.resolvedReason, oneOf(NOTICE_RESOLVED_REASONS)),
    dealId: nullable(o.dealId, uuid),
    dealReference: nullable(o.dealReference, anyString),
    taskId: nullable(o.taskId, uuid),
    department: nullable(o.department, oneOf(NOTICE_DEPARTMENTS)),
    params: params(o.params),
    link: nullable(o.link, link),
  };
}

const items = (v: unknown): NoticeItemDTO[] => (Array.isArray(v) ? v.map(item) : fail());

export function parseNoticeInbox(v: unknown): NoticeInboxDTO | null {
  try {
    const o = obj(v);
    return {
      enabled: bool(o.enabled),
      unreadCount: int(o.unreadCount, 0),
      urgentCount: int(o.urgentCount, 0),
      latestSeq: nullable(o.latestSeq, (x) => int(x, 1)),
      soundOn: bool(o.soundOn),
      // Accounts phase 3 (8.5): kept only when sent (pushEnabledOf reads missing as Off).
      ...(o.pushEnabled === undefined ? {} : { pushEnabled: bool(o.pushEnabled) }),
      // Accounts phase 2 (8.5): missing reads ON.
      popupsOn: o.popupsOn === undefined ? true : bool(o.popupsOn),
      items: items(o.items),
    };
  } catch (e) {
    if (e instanceof Invalid) return null;
    throw e;
  }
}

export function parseNoticeHistory(v: unknown): NoticeHistoryDTO | null {
  try {
    const o = obj(v);
    return { enabled: bool(o.enabled), items: items(o.items), nextBefore: nullable(o.nextBefore, (x) => int(x, 1)) };
  } catch (e) {
    if (e instanceof Invalid) return null;
    throw e;
  }
}
