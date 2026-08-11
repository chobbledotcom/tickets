/**
 * Activity log operations
 *
 * Activity logging for admin visibility. Messages are encrypted with the site
 * owner's public key (hybrid RSA+AES), so a database dump plus DB_ENCRYPTION_KEY
 * cannot read them — only an authenticated admin, whose password unwraps the
 * private key, can. Writing needs only the public key (which a set-up site
 * always has), so the many unauthenticated callers (webhooks, the error logger)
 * still log; reading pulls the private key from the current request's session
 * with no threading.
 *
 * Rows written before this change carry the legacy DB_ENCRYPTION_KEY format and
 * are still readable — {@link decryptLogMessage} routes by prefix. The
 * activity-log backfill job re-encrypts those legacy rows to the owner key over
 * time.
 */

import { isNullish } from "#fp";
import { decrypt } from "#shared/crypto/encryption.ts";
import {
  decryptWithOwnerKey,
  encryptWithOwnerKey,
  HYBRID_PREFIX,
} from "#shared/crypto/keys.ts";
import type {
  EnvKeyEncrypted,
  OwnerKeyEncrypted,
} from "#shared/crypto/sealed.ts";
import {
  executeBatchWithResults,
  queryAll,
  queryBatch,
  resultRows,
  type TxScope,
} from "#shared/db/client.ts";
import { idAndCreatedSchema } from "#shared/db/common-schema.ts";
import { decryptListingWithCount } from "#shared/db/listings/records.ts";
import { listingReader } from "#shared/db/listings/select.ts";
import { CONFIG_KEYS, settings } from "#shared/db/settings.ts";
import { col, defineTable } from "#shared/db/table.ts";
import { nowIso } from "#shared/now.ts";
import { requireValue } from "#shared/required-value.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import type { ListingWithCount } from "#shared/types.ts";

/** A stored log message: owner-key ciphertext for rows written since the
 * keypair existed, env-key ciphertext for legacy rows the backfill hasn't
 * re-encrypted yet. The format prefix routes decryption at runtime. */
export type StoredLogMessage = OwnerKeyEncrypted | EnvKeyEncrypted;

/** Activity log entry as callers see it: the message decrypted to plaintext. */
export interface ActivityLogEntry {
  attendee_id: number | null;
  created: string;
  id: number;
  listing_id: number | null;
  message: string;
}

/** An activity log row as stored — the message is still sealed ciphertext.
 * {@link decryptLogRows} turns these into plaintext {@link ActivityLogEntry}s. */
type StoredActivityLogEntry = Omit<ActivityLogEntry, "message"> & {
  message: StoredLogMessage;
};

/** Activity log input for create */
export type ActivityLogInput = {
  listingId?: number | null;
  attendeeId?: number | null;
  message: StoredLogMessage;
};

/**
 * Activity log table definition.
 *
 * `message` is a plain column here because its crypto can't be expressed as a
 * static transform: the write key is resolved at runtime (owner public key when
 * configured, else the env key) and the read key is the per-request private key.
 * {@link logActivity} and {@link decryptLogRows} own those two steps.
 */
export const activityLogTable = defineTable<
  StoredActivityLogEntry,
  ActivityLogInput
>({
  name: "activity_log",
  primaryKey: "id",
  schema: {
    ...idAndCreatedSchema(nowIso),
    attendee_id: col.simple<number | null>(),
    listing_id: col.simple<number | null>(),
    message: col.simple<StoredLogMessage>(),
  },
});
const ACTIVITY_LOG_COLUMNS = activityLogTable.columns.join(", ");

/** The whole stored entry — what every log read selects. */
const logEntries = activityLogTable.read;

/**
 * Newest first, by id rather than by created: id is AUTOINCREMENT so it rises
 * with created (newest row = highest id) but, being the rowid, it is served
 * straight from the primary key / idx_activity_log_listing_id without a sort
 * over the unbounded log table.
 */
const NEWEST_FIRST = { order: "id DESC" };

/**
 * Decrypt a stored log message, routing by format prefix: owner-key (hybrid)
 * rows need the session private key; legacy env-key rows decrypt without it.
 */
const decryptLogMessage = (
  message: StoredLogMessage,
  privateKey: CryptoKey | null,
): Promise<string> =>
  // The prefix is the runtime discriminator between the union's two kinds —
  // the narrowing the type system can't see, asserted per branch.
  message.startsWith(HYBRID_PREFIX)
    ? decryptWithOwnerKey(message as OwnerKeyEncrypted, privateKey as CryptoKey)
    : decrypt(message as EnvKeyEncrypted);

/**
 * The owner public key, loading it into the settings snapshot on demand if a
 * mid-request cache reset (setup, restore, database reset) blanked it. A set-up
 * site always has one in the DB, so this trusts that rather than falling back to
 * the env key; only genuinely pre-setup does it stay empty (and encryption then
 * throws, which the error logger swallows).
 */
const ownerPublicKey = async (): Promise<string> => {
  if (settings.publicKey) return settings.publicKey;
  await settings.loadKeys([CONFIG_KEYS.PUBLIC_KEY]);
  return settings.publicKey;
};

/** Accept an listing ID as a number or an object with `.id` */
type ListingRef = number | { id: number };

/** Extract listing ID from an ListingRef */
const toListingId = (listing?: ListingRef | null): number | null =>
  isNullish(listing)
    ? null
    : typeof listing === "number"
    ? listing
    : listing.id;

/** One thing to record in the log: what happened, and which listing/attendee it
 * happened to. */
export type ActivityToLog = {
  message: string;
  listing?: ListingRef | null | undefined;
  attendeeId?: number | null | undefined;
};

/**
 * Log several activities as ONE write. A booking with many lines records a line
 * apiece, and one insert per line would eat the edge request's subrequest
 * budget; a batch costs the same single round-trip however many there are, and
 * either they all land or none does. Returns the stored rows in the same order,
 * with their plaintext messages. A caller may pass its open write transaction so
 * the log and the action it records commit together.
 */
export const logActivities = async (
  activities: readonly ActivityToLog[],
  transaction?: TxScope,
): Promise<ActivityLogEntry[]> => {
  if (activities.length === 0) return [];
  // Encrypt with the owner's public key — a set-up site always has one, so
  // there is no env-key fallback (ownerPublicKey loads it if the snapshot was
  // reset earlier this request).
  const publicKey = await ownerPublicKey();
  const statements = await Promise.all(
    activities.map(async (activity) =>
      activityLogTable.insertStatement(
        {
          attendeeId: activity.attendeeId ?? null,
          listingId: toListingId(activity.listing),
          message: await encryptWithOwnerKey(activity.message, publicKey),
        },
        undefined,
        ACTIVITY_LOG_COLUMNS,
      )
    ),
  );
  const results = transaction
    ? await transaction.batch(statements)
    : await executeBatchWithResults(statements);
  return results.map((result, index) => ({
    ...resultRows<StoredActivityLogEntry>(result)[0]!,
    message: activities[index]!.message,
  }));
};

/**
 * Log one activity, through the shared many-activity write. Optionally
 * associate it with a listing and/or attendee so admin views can filter the log
 * by either.
 */
export const logActivity = async (
  message: string,
  listing?: ListingRef | null,
  attendeeId?: number | null,
  transaction?: TxScope,
): Promise<ActivityLogEntry> =>
  requireValue(
    (await logActivities([{ attendeeId, listing, message }], transaction))[0],
    "Activity log row missing",
  );

/**
 * Decrypt the messages of a batch of raw activity log rows. The session private
 * key is pulled from the current request only when at least one row is in the
 * owner-key format; a batch of purely legacy env-key rows (or an empty result)
 * decrypts without a key, so such pages still render where none is in scope.
 */
const decryptLogRows = async (
  rows: StoredActivityLogEntry[],
): Promise<ActivityLogEntry[]> => {
  const needsKey = rows.some((row) => row.message.startsWith(HYBRID_PREFIX));
  const privateKey = needsKey ? await requireRequestPrivateKey() : null;
  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      message: await decryptLogMessage(row.message, privateKey),
    })),
  );
};

/** Query activity log with optional listing filter, decrypts messages */
const queryActivityLog = async (
  listingId: number | null,
  limit: number,
): Promise<ActivityLogEntry[]> =>
  decryptLogRows(
    await logEntries.many(
      // A null listing means "every listing", which is no filter at all.
      listingId === null ? {} : { listing_id: listingId },
      { ...NEWEST_FIRST, limit },
    ),
  );

/**
 * Get activity log entries for an listing (most recent first)
 */
export const getListingActivityLog = (
  listingId: number,
  limit = 100,
): Promise<ActivityLogEntry[]> => queryActivityLog(listingId, limit);

/**
 * Get all activity log entries (most recent first)
 */
export const getAllActivityLog = (limit = 100): Promise<ActivityLogEntry[]> =>
  queryActivityLog(null, limit);

/**
 * Get activity log entries for a specific attendee (most recent first),
 * decrypting messages.
 */
export const getAttendeeActivityLog = async (
  attendeeId: number,
  limit = 100,
): Promise<ActivityLogEntry[]> =>
  decryptLogRows(
    await logEntries.many(
      { attendee_id: attendeeId },
      { ...NEWEST_FIRST, limit },
    ),
  );

/** Every decrypted activity message for one attendee, for durable replay checks. */
export const getAttendeeActivityMessages = async (
  attendeeId: number,
  privateKey: CryptoKey,
): Promise<string[]> =>
  await Promise.all(
    (
      await queryAll<{ message: StoredLogMessage }>(
        `SELECT activity.message
           FROM activity_log AS activity
          WHERE activity.attendee_id = ?`,
        [attendeeId],
      )
    ).map(({ message }) => decryptLogMessage(message, privateKey)),
  );

/** Result type for listing + activity log batch query */
export type ListingWithActivityLog = {
  listing: ListingWithCount;
  entries: ActivityLogEntry[];
};

/**
 * Get listing and its activity log in a single database round-trip.
 * Uses batch API to reduce latency for remote databases.
 */
export const getListingWithActivityLogOrNull = async (
  listingId: number,
  limit = 100,
): Promise<ListingWithActivityLog | null> => {
  const results = await queryBatch([
    listingReader.statement({ where: { ids: [listingId] } }),
    logEntries.statement({ listing_id: listingId }, { ...NEWEST_FIRST, limit }),
  ]);

  const listingRow = resultRows<ListingWithCount>(results[0]!)[0];
  if (!listingRow) return null;

  const listing = await decryptListingWithCount(listingRow);

  const entries = await decryptLogRows(
    resultRows<StoredActivityLogEntry>(results[1]!),
  );

  return { entries, listing };
};
