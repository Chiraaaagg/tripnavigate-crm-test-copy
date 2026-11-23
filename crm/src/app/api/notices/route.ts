import { noticeFeed } from '@/modules/notices/server/feed';

/**
 * Bell reads (notice inbox, history, unread count) over GET under the staff
 * member's own session; see src/modules/notices/server/feed.ts. Never cached.
 * Marks stay Server Actions (src/modules/notices/server/actions.ts).
 */
export async function GET(request: Request): Promise<Response> {
  return noticeFeed(request);
}
