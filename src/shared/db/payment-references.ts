/**
 * Provider payment references used by admin refunds.
 *
 * Stored references are owner-key encrypted: checkout/webhook code can write them
 * with the public key, and admin refund routes decrypt them only inside an
 * authenticated request.
 */

import { unique } from "#fp";
import {
  decryptWithOwnerKey,
  encryptWithOwnerKey,
  HYBRID_PREFIX,
} from "#shared/crypto/keys.ts";
import type { OwnerKeyEncrypted } from "#shared/crypto/sealed.ts";
import {
  execute,
  inPlaceholders,
  queryAll,
  type SqlStatement,
} from "#shared/db/client.ts";
import { settings } from "#shared/db/settings.ts";
import { nowIso } from "#shared/now.ts";

export type RefundPaymentReferenceSource = {
  id: number;
  payment_id: string;
};

export type RefundPaymentReference = {
  readonly providerRefunded: boolean;
  readonly reference: string;
  readonly sessionIds: readonly string[];
};

type PaymentReferenceRow = {
  attendee_id: number;
  payment_reference: string;
  payment_session_id: string;
  provider_refunded_at: string;
};

type PaymentReferenceAttendeeRow = {
  attendee_id: number;
};

const LEGACY_MERGE_SESSION_PREFIX = "legacy-merge:";

/** One reference's refund status while it is being built up from rows: whether
 *  the provider has refunded it, and the payment sessions seen so far. */
type ReferenceProgress = { providerRefunded: boolean; sessionIds: string[] };

/** In-progress refund references, keyed by the reference string. */
type ReferenceProgressByKey = Map<string, ReferenceProgress>;

export const encryptPaymentReference = async (
  reference: string,
): Promise<OwnerKeyEncrypted | ""> =>
  reference === "" ? "" : encryptWithOwnerKey(reference, settings.publicKey);

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
    "attendee_id, payment_session_id, payment_reference, provider_refunded_at",
    "ORDER BY attendee_id, processed_at, payment_session_id",
  );

const attendeeIdsWithProcessedReferences = (
  attendeeIds: readonly number[],
): Promise<PaymentReferenceAttendeeRow[]> =>
  queryProcessedReferences(attendeeIds, "DISTINCT attendee_id");

const legacyReference = (reference: string): RefundPaymentReference => ({
  providerRefunded: false,
  reference,
  sessionIds: [],
});

const withLegacyReference = (
  references: RefundPaymentReference[],
  legacyPaymentId: string,
): RefundPaymentReference[] =>
  legacyPaymentId !== "" &&
  !references.some((entry) => entry.reference === legacyPaymentId)
    ? [...references, legacyReference(legacyPaymentId)]
    : references;

const realSessionIds = (row: PaymentReferenceRow): string[] =>
  row.payment_session_id.startsWith(LEGACY_MERGE_SESSION_PREFIX)
    ? []
    : [row.payment_session_id];

const addReference = (
  byReference: ReferenceProgressByKey,
  row: PaymentReferenceRow,
  reference: string,
): void => {
  const sessionIds = realSessionIds(row);
  const existing = byReference.get(reference);
  if (existing) {
    existing.sessionIds.push(...sessionIds);
    existing.providerRefunded ||= row.provider_refunded_at !== "";
  } else {
    byReference.set(reference, {
      providerRefunded: row.provider_refunded_at !== "",
      sessionIds,
    });
  }
};

const asRefundReferences = (
  byReference: ReferenceProgressByKey,
): RefundPaymentReference[] =>
  [...byReference].map(([reference, data]) => ({
    providerRefunded: data.providerRefunded,
    reference,
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
  for (const row of await paymentReferencesForIds(
    attendees.map((attendee) => attendee.id),
  )) {
    const reference = await decryptPaymentReference(
      row.payment_reference,
      privateKey,
    );
    if (reference) {
      addReference(byAttendee.get(Number(row.attendee_id))!, row, reference);
    }
  }
  return new Map(
    attendees.map((attendee) => {
      const references = withLegacyReference(
        asRefundReferences(byAttendee.get(attendee.id)!),
        attendee.payment_id,
      );
      return [attendee.id, references];
    }),
  );
};

export const hasRefundPaymentReference = async (
  attendee: RefundPaymentReferenceSource,
  privateKey: CryptoKey,
): Promise<boolean> =>
  (await getRefundPaymentReferences([attendee], privateKey)).get(attendee.id)!
    .length > 0;

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
        ],
        sql: `INSERT OR IGNORE INTO processed_payments
              (payment_session_id, attendee_id, processed_at, payment_reference)
              VALUES (?, ?, ?, ?)`,
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
  if (sessionIds.length === 0) return;
  await execute(
    `UPDATE processed_payments
        SET provider_refunded_at = COALESCE(NULLIF(provider_refunded_at, ''), ?)
      WHERE payment_session_id IN (${inPlaceholders(sessionIds)})`,
    [nowIso(), ...sessionIds],
  );
};
