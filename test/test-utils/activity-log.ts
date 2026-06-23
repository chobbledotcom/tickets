/**
 * Session-bound activity-log readers for tests.
 *
 * Activity-log messages are encrypted with the owner key, so reading them needs
 * the request's private key. In production those reads happen inside an
 * authenticated admin session; these wrappers reproduce that by running the
 * real reader inside the test owner's session context (see {@link
 * withTestSession}). A test that merely wants to assert "this action was
 * logged" can therefore call them exactly like the real functions — just
 * import from `#test-utils` instead of `#shared/db/activityLog.ts`.
 *
 * `logActivity` (a write) needs no session, so it is re-exported unchanged for
 * the convenience of files that both write and read the log.
 *
 * Tests that exercise the encryption itself, or the no-session fail-closed
 * path, should import the real readers from `#shared/db/activityLog.ts`.
 */

import type {
  ActivityLogEntry,
  ListingWithActivityLog,
} from "#shared/db/activityLog.ts";
import {
  getAllActivityLog as realGetAllActivityLog,
  getAttendeeActivityLog as realGetAttendeeActivityLog,
  getListingActivityLog as realGetListingActivityLog,
  getListingWithActivityLog as realGetListingWithActivityLog,
} from "#shared/db/activityLog.ts";
import { withTestSession } from "#test-utils/session.ts";

export { logActivity } from "#shared/db/activityLog.ts";

export const getAllActivityLog = (
  limit?: number,
): Promise<ActivityLogEntry[]> =>
  withTestSession(() => realGetAllActivityLog(limit));

export const getListingActivityLog = (
  listingId: number,
  limit?: number,
): Promise<ActivityLogEntry[]> =>
  withTestSession(() => realGetListingActivityLog(listingId, limit));

export const getAttendeeActivityLog = (
  attendeeId: number,
  limit?: number,
): Promise<ActivityLogEntry[]> =>
  withTestSession(() => realGetAttendeeActivityLog(attendeeId, limit));

export const getListingWithActivityLog = (
  listingId: number,
  limit?: number,
): Promise<ListingWithActivityLog | null> =>
  withTestSession(() => realGetListingWithActivityLog(listingId, limit));
