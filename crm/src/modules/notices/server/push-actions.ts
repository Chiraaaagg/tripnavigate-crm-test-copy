'use server';

import { createHash, randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { requireStaff } from '@/modules/identity/server/session';
import {
  PushCommandError,
  adminSetPushEnabled,
  pushDeviceRegister,
  pushDeviceRemove,
  pushDeviceRemoveCurrent,
  pushDevicesList,
  pushTestSend,
} from '../commands';
import {
  NOTICE_ERROR_TEXT,
  PUSH_ERROR_TEXT,
  PUSH_OK_TEXT,
  PUSH_SWITCH_TEXT,
  type PushDevicesListDTO,
} from '../contracts';
import type { NoticeSwitchResult, PushRegisterResult, PushRemoveCurrentResult, PushRemoveResult, PushTestResult } from '../dto';

/**
 * "Alerts on this device" (Accounts phase 3 contract 8.3 D1-D5, screen 15.8).
 * Each action calls requireStaff() and then the database command under the
 * staff member's OWN session: a person only ever sees and changes their own
 * devices (the actor is never taken from input). The endpoint and keys go to
 * the database and nowhere else; they are never logged or returned. Results:
 * { ok: true, data, message? } | { ok: false, code, message } (never a
 * database message).
 */

export type PushActionResult<T> = { ok: true; data: T; message?: string } | { ok: false; code: string; message: string };

const endpointSchema = z.string().min(9).max(1000).regex(/^https:\/\/\S+$/);
const keySchema = z.string().regex(/^[A-Za-z0-9_-]{16,200}={0,2}$/);
const labelSchema = z.string().trim().min(1).max(60).regex(/^[^\p{Cc}]+$/u);
const uuidSchema = z.uuid();

function failure(error: unknown): { ok: false; code: string; message: string } {
  if (error instanceof PushCommandError && error.code) {
    return { ok: false, code: error.code, message: PUSH_ERROR_TEXT[error.code] };
  }
  return { ok: false, code: 'failed', message: PUSH_ERROR_TEXT.failed };
}

const invalid = { ok: false as const, code: 'invalid_input', message: NOTICE_ERROR_TEXT.invalid_input };

function requestIdOf(value: unknown): string {
  const parsed = uuidSchema.safeParse(value);
  return parsed.success ? parsed.data : randomUUID();
}

function endpointHash(endpoint: string): string {
  return createHash('sha256').update(endpoint, 'utf8').digest('hex');
}

/** D3: the caller's devices; `endpoint` = this browser's subscription endpoint (marks "this device"), or null. */
export async function listPushDevicesAction(endpoint: string | null): Promise<PushActionResult<PushDevicesListDTO>> {
  const staff = await requireStaff();
  let hash: string | null = null;
  if (endpoint !== null) {
    const ep = endpointSchema.safeParse(endpoint);
    if (!ep.success) return invalid;
    hash = endpointHash(ep.data);
  }
  try {
    const data = await pushDevicesList(asRpcClient(staff.supabase), hash);
    return data ? { ok: true, data } : { ok: false, code: 'not_authorized', message: PUSH_ERROR_TEXT.not_authorized };
  } catch (error) {
    return failure(error);
  }
}

export interface RegisterPushDeviceInput {
  endpoint: string;
  p256dh: string;
  authKey: string;
  label: string;
  requestId?: string;
}

/** D1: called by the browser adapter after the person pressed "Turn on" and the browser subscribed. */
export async function registerPushDeviceAction(input: RegisterPushDeviceInput): Promise<PushActionResult<PushRegisterResult>> {
  const staff = await requireStaff();
  const endpoint = endpointSchema.safeParse(input?.endpoint);
  const p256dh = keySchema.safeParse(input?.p256dh);
  const authKey = keySchema.safeParse(input?.authKey);
  const label = labelSchema.safeParse(input?.label);
  if (!endpoint.success || !p256dh.success || !authKey.success || !label.success) return invalid;
  try {
    const data = await pushDeviceRegister(asRpcClient(staff.supabase), {
      endpoint: endpoint.data, p256dh: p256dh.data, authKey: authKey.data, label: label.data, requestId: requestIdOf(input.requestId),
    });
    return { ok: true, data, message: PUSH_OK_TEXT.turnedOn };
  } catch (error) {
    return failure(error);
  }
}

/** D2: "Remove" in the device list (own devices only). */
export async function removePushDeviceAction(deviceId: string, requestId?: string): Promise<PushActionResult<PushRemoveResult>> {
  const staff = await requireStaff();
  const id = uuidSchema.safeParse(deviceId);
  if (!id.success) return invalid;
  try {
    const data = await pushDeviceRemove(asRpcClient(staff.supabase), id.data, requestIdOf(requestId));
    return { ok: true, data, message: PUSH_OK_TEXT.removed };
  } catch (error) {
    return failure(error);
  }
}

/** D2: "Turn off on this device" (the browser adapter unsubscribes this browser too). */
export async function removeCurrentPushDeviceAction(endpoint: string): Promise<PushActionResult<PushRemoveCurrentResult>> {
  const staff = await requireStaff();
  const ep = endpointSchema.safeParse(endpoint);
  if (!ep.success) return invalid;
  try {
    const data = await pushDeviceRemoveCurrent(asRpcClient(staff.supabase), ep.data);
    return { ok: true, data, message: PUSH_OK_TEXT.turnedOff };
  } catch (error) {
    return failure(error);
  }
}

/** D4: "Send a test alert" (at most 3 per 10 minutes). */
export async function sendPushTestAction(deviceId: string, requestId?: string): Promise<PushActionResult<PushTestResult>> {
  const staff = await requireStaff();
  const id = uuidSchema.safeParse(deviceId);
  if (!id.success) return invalid;
  try {
    const data = await pushTestSend(asRpcClient(staff.supabase), id.data, requestIdOf(requestId));
    return { ok: true, data, message: PUSH_OK_TEXT.testQueued };
  } catch (error) {
    return failure(error);
  }
}

type SwitchPrev = PushActionResult<NoticeSwitchResult> | null;

/** D5 admin settings: the alerts switch (Super Admin; form fields `enabled` = 'true' | 'false' and `reason`). */
export async function setPushEnabledAction(_prev: SwitchPrev, formData: FormData): Promise<PushActionResult<NoticeSwitchResult>> {
  const staff = await requireStaff();
  const enabled = formData.get('enabled');
  const reason = formData.get('reason');
  if ((enabled !== 'true' && enabled !== 'false') || typeof reason !== 'string') return invalid;
  const trimmed = reason.trim();
  if (trimmed.length < 10 || trimmed.length > 500) return { ok: false, code: 'invalid_input', message: PUSH_SWITCH_TEXT.reason };
  try {
    const data = await adminSetPushEnabled(asRpcClient(staff.supabase), enabled === 'true', trimmed);
    revalidatePath('/app', 'layout');
    return { ok: true, data, message: data.after ? PUSH_SWITCH_TEXT.on : PUSH_SWITCH_TEXT.off };
  } catch (error) {
    if (error instanceof PushCommandError && error.code === 'not_authorized') {
      return { ok: false, code: 'not_authorized', message: PUSH_SWITCH_TEXT.notAllowed };
    }
    if (error instanceof PushCommandError && error.code === 'invalid_input') {
      return { ok: false, code: 'invalid_input', message: PUSH_SWITCH_TEXT.reason };
    }
    return failure(error);
  }
}
