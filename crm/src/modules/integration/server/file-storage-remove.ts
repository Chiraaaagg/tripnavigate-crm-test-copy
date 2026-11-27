import 'server-only';

/**
 * S11 "files to Bitrix": the ONLY place in the application that removes a
 * Storage object (decision D5; a unit test fails if any other file calls
 * Storage remove).
 *
 * It is called by the file-move worker for one row in state delete_pending,
 * after the database recorded two matching observations of the Bitrix copy
 * (the second after the hold and after the last append to that box). This
 * function does not decide anything: whether the object is really gone is
 * decided afterwards by file_move_confirm_deleted, which looks at Storage
 * itself. Removing an absent object is harmless (Storage answers with an
 * empty list).
 *
 * Only the six S11 source buckets are allowed, one path per call. Answers are
 * fixed codes; never the path, the bucket or the Storage message.
 */

export const S11_SOURCE_BUCKETS = [
  'traveller-id-proofs',
  'department-evidence',
  'customer-party-documents',
  'finance-evidence',
  'supplier-money',
  'booking-evidence',
] as const;

export const STORAGE_REMOVE_TIMEOUT_MS = 10_000;

/** The smallest Storage surface this function needs (the service-role Supabase client fits it). */
export interface StorageRemoveClient {
  storage: {
    from(bucket: string): {
      remove(paths: string[]): PromiseLike<{ data: unknown; error: unknown }>;
    };
  };
}

export type StorageRemoveResult = { kind: 'removed' } | { kind: 'refused'; code: 'bucket_not_allowed' | 'invalid_path' } | { kind: 'error'; code: 'storage_error' | 'timeout' };

/** A plain object path: no leading slash, no empty, "." or ".." segment, no control character. */
function isPlainObjectPath(path: string): boolean {
  if (path.length === 0 || path.length > 1024 || path.startsWith('/') || path.endsWith('/')) return false;
  for (let i = 0; i < path.length; i += 1) {
    const c = path.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || c === 0x5c) return false;
  }
  return path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

export async function removeMovedSourceObject(
  client: StorageRemoveClient,
  bucket: string,
  objectPath: string,
  timeoutMs: number = STORAGE_REMOVE_TIMEOUT_MS,
): Promise<StorageRemoveResult> {
  if (!(S11_SOURCE_BUCKETS as readonly string[]).includes(bucket)) return { kind: 'refused', code: 'bucket_not_allowed' };
  if (!isPlainObjectPath(objectPath)) return { kind: 'refused', code: 'invalid_path' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    const answer = await Promise.race([Promise.resolve(client.storage.from(bucket).remove([objectPath])), timeout]);
    if (answer === 'timeout') return { kind: 'error', code: 'timeout' };
    return answer.error ? { kind: 'error', code: 'storage_error' } : { kind: 'removed' };
  } catch {
    return { kind: 'error', code: 'storage_error' };
  } finally {
    clearTimeout(timer);
  }
}
