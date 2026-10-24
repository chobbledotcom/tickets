/**
 * Session-bound activity-log readers for tests.
 *
 * Activity-log messages are encrypted with the owner key, so reading them needs
 * the request's private key. In production those reads happen inside an
 * authenticated admin session; these wrappers reproduce that by running the
 * real reader inside the test owner's session context (see {@link
 * withTestSession}). A test that merely wants to assert "this action was
 * logged" can therefore call them exactly like the real functions — just
 * import from `#test-utils` instead of `#shared/db/activity-log.ts`.
 *
 * `logActivity` (a write) needs no session, so it is re-exported unchanged for
 * the convenience of files that both write and read the log.
 *
 * Tests that exercise the encryption itself, or the no-session fail-closed
 * path, should import the real readers from `#shared/db/activity-log.ts`.
 */

import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { encrypt } from "#crypto/encryption.ts";
import {
  type ActivityLogEntry,
  type ListingWithActivityLog,
  getAllActivityLog as realGetAllActivityLog,
  getAttendeeActivityLog as realGetAttendeeActivityLog,
  getListingActivityLog as realGetListingActivityLog,
  getListingWithActivityLogOrNull as realGetListingWithActivityLogOrNull,
} from "#db/activity-log.ts";
import { execute, queryOne } from "#db/client.ts";
import { nowIso } from "#shared/now.ts";
import { adminGet, withTestSession } from "#test-utils/session.ts";

export { logActivity } from "#db/activity-log.ts";

/** Insert a row encrypted with DB_ENCRYPTION_KEY (the pre-migration format). */
export const insertLegacyActivity = async (
  message: string,
): Promise<number> => {
  const result = await execute(
    "INSERT INTO activity_log (message, created, listing_id, attendee_id) VALUES (?, ?, NULL, NULL)",
    [await encrypt(message), nowIso()],
  );
  return Number(result.lastInsertRowid);
};

/** Raw (still-encrypted) stored message for an activity-log row. */
export const rawActivityMessage = async (id: number): Promise<string> => {
  const row = await queryOne<{ message: string }>(
    "SELECT message FROM activity_log WHERE id = ?",
    [id],
  );
  if (!row) throw new Error(`Activity log entry not found: ${id}`);
  return row.message;
};

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

export const getListingWithActivityLogOrNull = (
  listingId: number,
  limit?: number,
): Promise<ListingWithActivityLog | null> =>
  withTestSession(() => realGetListingWithActivityLogOrNull(listingId, limit));

/** True when the activity log holds an entry whose message equals `message`. */
export const wasActivityLogged = async (message: string): Promise<boolean> =>
  (await getAllActivityLog()).some((entry) => entry.message === message);

/** The decrypted messages currently in the activity log, for "was it logged" asserts. */
export const activityMessages = async (): Promise<string[]> =>
  (await getAllActivityLog()).map((entry) => entry.message);

export const expectActivityLogShows = async (
  name: string,
  verb: string,
): Promise<void> => {
  const response = await adminGet("/admin/log");
  const body = await response.text();
  assertStringIncludes(body, name);
  assertStringIncludes(body, verb);
};

const listingActivityLogHasMessage = async (
  listingId: number,
  substring: string,
): Promise<boolean> => {
  const entries = await getListingActivityLog(listingId);
  return entries.some((entry) => entry.message.includes(substring));
};

type ListingActivityLogCheck = (
  listingId: number,
  substring: string,
) => Promise<void>;

/** Assert whether the listing's activity log holds an entry whose message
 * includes `substring` — one check, specialised below into the "has it" and
 * "has not" forms the tests read with. */
const expectListingActivityLog =
  (present: boolean) =>
  async (listingId: number, substring: string): Promise<void> => {
    expect(await listingActivityLogHasMessage(listingId, substring)).toBe(
      present,
    );
  };

/** Assert the listing's activity log has an entry whose message includes `substring`. */
export const expectListingActivityLogContains: ListingActivityLogCheck =
  expectListingActivityLog(true);

/** Assert the listing's activity log has no entry whose message includes `substring`. */
export const expectListingActivityLogLacks: ListingActivityLogCheck =
  expectListingActivityLog(false);
