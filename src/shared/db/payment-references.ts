/**
 * Provider payment references used by admin refunds.
 *
 * Stored references are owner-key encrypted: checkout/webhook code can write them
 * with the public key, and admin refund routes decrypt them only inside an
 * authenticated request.
 */

import { unique } from "#fp";
import { hmacHash } from "#shared/crypto/hashing.ts";
import {
  decryptWithOwnerKey,
  encryptWithOwnerKey,
  HYBRID_PREFIX,
} from "#shared/crypto/keys.ts";
import type { OwnerKeyEncrypted } from "#shared/crypto/sealed.ts";
/* jscpd:ignore-start */
import {
  execute,
  executeBatch,
  inPlaceholders,
  queryAll,
  type SqlStatement,
} from "#shared/db/client.ts";
import { settings } from "#shared/db/settings.ts";
import { nowIso } from "#shared/now.ts";
import type { RefundState } from "#shared/payment/refund-state.ts";
import { refundStateOf } from "#shared/payment/refund-state.ts";
/* jscpd:ignore-end */

export type RefundPaymentReferenceSource = {
  id: number;
  payment_id: string;
};

export type RefundPaymentReference = {
  /** The blind one-way index of this reference, carried from the read so no
   *  later step has to hash it again. */
  readonly index: string;
  readonly refundState: RefundState;
  readonly reference: string;
  /** Non-legacy sessions ordered by processing time, then session ID. */
  readonly sessionIds: readonly string[];
};

type PaymentReferenceRow = {
  attendee_id: number;
  payment_reference: string;
  payment_reference_index: string;
  payment_session_id: string;
  provider_refunded_at: string;
};

type PaymentReferenceAttendeeRow = {
  attendee_id: number;
};

const LEGACY_MERGE_SESSION_PREFIX = "legacy-merge:";

/**
 * Whether this row is a merge anchor rather than a real checkout.
 *
 * A merge writes one of these to carry an inherited legacy payment, and the
 * reference list deliberately hides its id — so anything comparing a claim's
 * rows against that list has to know they were left out on purpose.
 */
export const isLegacyMergeSession = (sessionId: string): boolean =>
  sessionId.startsWith(LEGACY_MERGE_SESSION_PREFIX);

/** One reference's refund status while it is being built up from rows: its
 *  blind index, whether the provider has refunded it, and the payment sessions
 *  seen so far. */
type ReferenceProgress = {
  index: string;
  refunded: boolean;
  sessionIds: string[];
};

/** In-progress refund references, keyed by the reference string. */
type ReferenceProgressByKey = Map<string, ReferenceProgress>;

export const encryptPaymentReference = async (
  reference: string,
): Promise<OwnerKeyEncrypted | ""> =>
  reference === "" ? "" : encryptWithOwnerKey(reference, settings.publicKey);

/**
 * The blind one-way index of a reference's identity, written beside the
 * encrypted reference itself.
 *
 * A refund claim needs to ask "is another row already working on this same
 * provider money?" in SQL, without decrypting every row to find out. The same
 * reference always hashes to the same index, so the question is a lookup; the
 * index reveals nothing about the reference to anyone reading the table.
 */
export const paymentReferenceIndex = async (
  reference: string,
): Promise<string> => (reference === "" ? "" : await hmacHash(reference));

const decryptPaymentReference = (
  stored: string,
  privateKey: CryptoKey,
): Promise<string> | string => {
  if (stored.startsWith(HYBRID_PREFIX)) {
    return decryptWithOwnerKey(stored as OwnerKeyEncrypted, privateKey);
  }
  // Development builds of the in-flight migration wrote this column in the clear.
  // Keep those rows refundable while every new write stores owner-key ciphertext.
  return stored;
};

const queryProcessedReferences = <Row>(
  attendeeIds: readonly number[],
  select: string,
  suffix = "",
): Promise<Row[]> =>
  attendeeIds.length === 0
    ? Promise.resolve([])
    : queryAll<Row>(
        `SELECT ${select}
           FROM processed_payments
          WHERE attendee_id IN (${inPlaceholders(attendeeIds)})
            AND payment_reference != ''
          ${suffix}`,
        [...attendeeIds],
      );

const paymentReferencesForIds = (
  attendeeIds: readonly number[],
): Promise<PaymentReferenceRow[]> =>
  queryProcessedReferences(
    attendeeIds,
    `attendee_id, payment_session_id, payment_reference,
     payment_reference_index, provider_refunded_at`,
    "ORDER BY attendee_id, processed_at, payment_session_id",
  );

const attendeeIdsWithProcessedReferences = (
  attendeeIds: readonly number[],
): Promise<PaymentReferenceAttendeeRow[]> =>
  queryProcessedReferences(attendeeIds, "DISTINCT attendee_id");

const legacyReference = async (
  reference: string,
): Promise<RefundPaymentReference> => ({
  index: await paymentReferenceIndex(reference),
  reference,
  // A legacy charge (an old payment_id with no session) starts "unknown": this
  // system never watched its refund, so it may or may not have been returned.
  refundState: refundStateOf({ legacy: true, refunded: false }),
  sessionIds: [],
});

const withLegacyReference = async (
  references: RefundPaymentReference[],
  legacyPaymentId: string,
): Promise<RefundPaymentReference[]> =>
  legacyPaymentId !== "" &&
  !references.some((entry) => entry.reference === legacyPaymentId)
    ? [...references, await legacyReference(legacyPaymentId)]
    : references;

const realSessionIds = (row: PaymentReferenceRow): string[] =>
  isLegacyMergeSession(row.payment_session_id) ? [] : [row.payment_session_id];

const addReference = (
  byReference: ReferenceProgressByKey,
  row: PaymentReferenceRow,
  reference: string,
  index: string,
): void => {
  const sessionIds = realSessionIds(row);
  const existing = byReference.get(reference);
  if (existing) {
    existing.sessionIds.push(...sessionIds);
    existing.refunded ||= row.provider_refunded_at !== "";
  } else {
    byReference.set(reference, {
      index,
      refunded: row.provider_refunded_at !== "",
      sessionIds,
    });
  }
};

const asRefundReferences = (
  byReference: ReferenceProgressByKey,
): RefundPaymentReference[] =>
  [...byReference].map(([reference, data]) => ({
    index: data.index,
    reference,
    // A reference with no live sessions is a legacy charge (its rows were all
    // legacy-merge entries), so an unconfirmed refund reads as "unknown" rather
    // than a definite "none".
    refundState: refundStateOf({
      legacy: data.sessionIds.length === 0,
      refunded: data.refunded,
    }),
    sessionIds: data.sessionIds,
  }));

/**
 * Refundable provider references for each attendee. New processed_payments rows
 * carry per-session references; old single-charge bookings may still only have
 * attendees' legacy payment_id, so include it when it is not already present.
 */
export const getRefundPaymentReferences = async (
  attendees: readonly RefundPaymentReferenceSource[],
  privateKey: CryptoKey,
): Promise<Map<number, RefundPaymentReference[]>> => {
  const byAttendee = new Map(
    attendees.map((attendee) => [
      attendee.id,
      new Map<string, ReferenceProgress>(),
    ]),
  );
  const missingIndexes: SqlStatement[] = [];
  for (const row of await paymentReferencesForIds(
    attendees.map((attendee) => attendee.id),
  )) {
    const reference = await decryptPaymentReference(
      row.payment_reference,
      privateKey,
    );
    if (!reference) continue;
    const stored = row.payment_reference_index;
    const index =
      stored === "" ? await paymentReferenceIndex(reference) : stored;
    if (stored === "") missingIndexes.push(indexRepair(row, index));
    addReference(
      byAttendee.get(Number(row.attendee_id))!,
      row,
      reference,
      index,
    );
  }
  if (missingIndexes.length > 0) await executeBatch(missingIndexes);
  return new Map(
    await Promise.all(
      attendees.map(
        async (attendee): Promise<[number, RefundPaymentReference[]]> => [
          attendee.id,
          await withLegacyReference(
            asRefundReferences(byAttendee.get(attendee.id)!),
            attendee.payment_id,
          ),
        ],
      ),
    ),
  );
};

/**
 * Write the blind index onto a row that predates the column.
 *
 * Only an authenticated request can do this: the index is derived from the
 * reference, and the reference is owner-key encrypted, so nothing running
 * without the owner's key — a migration, the prune — could ever fill it in.
 * The refund path already decrypts the reference, so the first admin to look
 * at the attendee repairs the row for every later claim. Writing only into an
 * empty column keeps this idempotent and keeps it from ever overwriting an
 * index a live write just put there.
 */
const indexRepair = (
  row: PaymentReferenceRow,
  index: string,
): SqlStatement => ({
  args: [index, row.payment_session_id],
  sql: `UPDATE processed_payments
           SET payment_reference_index = ?
         WHERE payment_session_id = ? AND payment_reference_index = ''`,
});

/** The refund payment references for one attendee (never null). */
export const getRefundPaymentReferencesForAttendee = async (
  attendee: RefundPaymentReferenceSource,
  privateKey: CryptoKey,
): Promise<RefundPaymentReference[]> =>
  (await getRefundPaymentReferences([attendee], privateKey)).get(attendee.id)!;

export const hasRefundPaymentReference = async (
  attendee: RefundPaymentReferenceSource,
  privateKey: CryptoKey,
): Promise<boolean> =>
  (await getRefundPaymentReferencesForAttendee(attendee, privateKey)).length >
  0;

export const getAttendeeIdsWithPaymentReference = async (
  attendees: readonly RefundPaymentReferenceSource[],
): Promise<Set<number>> => {
  const ids = new Set(
    attendees
      .filter((attendee) => attendee.payment_id !== "")
      .map((attendee) => attendee.id),
  );
  for (const row of await attendeeIdsWithProcessedReferences(
    attendees.map((attendee) => attendee.id),
  )) {
    ids.add(Number(row.attendee_id));
  }
  return ids;
};

export const hasAnyPaymentReference = async (
  attendee: RefundPaymentReferenceSource,
): Promise<boolean> =>
  (await getAttendeeIdsWithPaymentReference([attendee])).has(attendee.id);

export const legacyMergePaymentReferenceStatement = async (
  targetId: number,
  sourceId: number,
  sourcePaymentId: string,
): Promise<SqlStatement | null> =>
  sourcePaymentId === ""
    ? null
    : {
        args: [
          `${LEGACY_MERGE_SESSION_PREFIX}${sourceId}`,
          targetId,
          nowIso(),
          await encryptPaymentReference(sourcePaymentId),
          await paymentReferenceIndex(sourcePaymentId),
        ],
        // The index goes in with the reference, as everywhere else: a refund
        // claim finds another row holding the same money by this column alone,
        // so an anchor written without one is money no claim can see.
        sql: `INSERT OR IGNORE INTO processed_payments
              (payment_session_id, attendee_id, processed_at, payment_reference,
               payment_reference_index)
              VALUES (?, ?, ?, ?, ?)`,
      };

/**
 * Mark processed-payment rows whose provider refund has already happened. The
 * ledger is still the source of the attendee's full-refund status; this per-charge
 * marker lets a later retry finish the remaining charges without re-calling the
 * provider for the ones already returned.
 */
export const markPaymentReferencesProviderRefunded = async (
  references: readonly RefundPaymentReference[],
): Promise<void> => {
  const sessionIds = unique(
    references.flatMap((reference) => reference.sessionIds),
  );
  // Mark by the reference's identity, not only by the sessions this attendee
  // holds: two attendees can carry one provider reference, and money returned
  // against it is returned for both. Marking only our own rows would leave the
  // other row looking untouched, and a run arriving before the provider's own
  // evidence caught up would send the same money again.
  const indexes = unique(references.map((reference) => reference.index)).filter(
    (index) => index !== "",
  );
  if (sessionIds.length === 0 && indexes.length === 0) return;
  await execute(
    `UPDATE processed_payments
        SET provider_refunded_at = COALESCE(NULLIF(provider_refunded_at, ''), ?)
      WHERE payment_session_id IN (${inPlaceholders(sessionIds)})
         OR (payment_reference_index != ''
             AND payment_reference_index IN (${inPlaceholders(indexes)}))`,
    [nowIso(), ...sessionIds, ...indexes],
  );
};
