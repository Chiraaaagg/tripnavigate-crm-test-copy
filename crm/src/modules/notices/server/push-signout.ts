import 'server-only';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { randomUUID } from 'node:crypto';
import { pushDeviceRemoveCurrent, pushDevicesRemoveAll } from '../commands';
import { PUSH_SIGNOUT_FIELD } from '../contracts';

/**
 * Sign-out removes this browser's alert device (Accounts phase 3 contract
 * 8.3 D2, 8.4; risk R10 "push on shared computers"). The sign-out form carries
 * this browser's subscription endpoint in the hidden field `pushEndpoint`
 * (filled by push-client.ts `pushEndpointForSignOut()`); the identity sign-out
 * action calls this with its own server client BEFORE ending the session.
 * Never throws: a failure must not stop the sign-out (the device is then
 * removed by a 404 / 410 from the push service or the 60-day cleanup).
 */
export async function removePushDeviceOnSignOut(supabase: { rpc: (...args: never[]) => unknown }, formData: FormData): Promise<void> {
  const raw = formData.get(PUSH_SIGNOUT_FIELD);
  if (typeof raw !== 'string' || raw.length < 9 || raw.length > 1000 || !/^https:\/\/\S+$/.test(raw)) return;
  try {
    await pushDeviceRemoveCurrent(asRpcClient(supabase), raw);
  } catch {
    // Signing out still goes ahead.
  }
}

/**
 * "Sign out of all devices" (Addendum O3): removes every active alert device
 * of the caller. Call with the signed-in server client BEFORE the session
 * barrier moves. Never throws.
 */
export async function removeAllPushDevicesOnSignOut(supabase: { rpc: (...args: never[]) => unknown }): Promise<void> {
  try {
    await pushDevicesRemoveAll(asRpcClient(supabase), randomUUID());
  } catch {
    // Signing out still goes ahead.
  }
}
