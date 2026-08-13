/**
 * Provider payment references used by admin refunds.
 *
 * Stored references are owner-key encrypted: checkout/webhook code can write them
 * with the public key, and admin refund routes decrypt them only inside an
 * authenticated request.
 */

import { requiredMapValue, unique } from "#fp";
/* jscpd:ignore-start */
import {
  execute,
  inPlaceholders,
  type SqlStatement,
} from "#shared/db/client.ts";
import { paymentAnchorReference } from "#shared/db/payment-anchor/reference.ts";
import {
  isAnchorSession,
  legacyMergeSessionId,
} from "#shared/db/payment-anchor/session.ts";
import {
  loadSelectedPaymentReferenceRows,
  type PaymentReferenceRow,
  querySelectedPaymentReferenceRows,
} from "#shared/db/payment-reference-rows.ts";
import {
  loadIndexedPaymentReference,
  matchingPaymentReferenceIndexes,
} from "#shared/db/payment-reference-store.ts";
import { nowIso } from "#shared/now.ts";
import { CLAIM_MIRROR } from "#shared/payment/admit-move.ts";
import type {
  PaymentReference,
  TaggedPaymentReference,
  UntaggedPaymentReference,
} from "#shared/payment/provider-reference.ts";
import type { RefundState } from "#shared/payment/refund-state.ts";
import { refundStateOf } from "#shared/payment/refund-state.ts";
/* jscpd:ignore-end */

export type RefundPaymentReferenceSource = {
  id: number;
  payment_id: string;
};

/** The decrypted current PII identity supplied at refund admission. Naming it
 * differently keeps raw attendee rows from satisfying this boundary. */
export type RefundPaymentReferenceOwner = {
  readonly currentPaymentId: string;
  readonly id: number;
};

type RefundPaymentReferenceFacts = {
  /** The rows carrying this charge that a refund run is still holding. A run
   *  that finished its money but lost the write that lets go leaves its hold
   *  behind, and nothing else in the system ever takes one off. */
  readonly heldRowSessionIds: readonly string[];
  /** The blind one-way index of this reference, carried from the read so no
   *  later step has to hash it again. */
  readonly index: string;
  /** Blind identities that may be an older/newer spelling of this same
   *  provider charge. Known providers with the same raw id stay distinct. */
  readonly matchingIndexes: readonly string[];
  readonly refundState: RefundState;
  /** Every indexed payment row carrying this charge, anchors included. */
  readonly rowSessionIds: readonly [string, ...string[]];
  /** Non-legacy sessions ordered by processing time, then session ID. */
  readonly sessionIds: readonly string[];
};

export type RefundPaymentReference =
  | (RefundPaymentReferenceFacts & TaggedPaymentReference)
  | (RefundPaymentReferenceFacts & UntaggedPaymentReference);

/** One attendee's complete refundable identities, or proof that old rows make
 * the set incomplete. No caller may receive the visible subset in the latter
 * case. */
export type RefundPaymentReferenceSet =
  | { readonly kind: "complete"; readonly references: RefundPaymentReference[] }
  | { readonly kind: "legacy_unindexed" };

/** Keep the final loaded facts for each stable payment identity. */
export const paymentReferencesByIndex = <
  Reference extends { readonly index: string },
>(
  owners: readonly { readonly references: readonly Reference[] }[],
): ReadonlyMap<string, Reference> =>
  new Map(
    owners
      .flatMap(({ references }) => references)
      .map((reference) => [reference.index, reference]),
  );

type PaymentReferenceAttendeeRow = {
  attendee_id: number;
};

/** One reference's refund status while it is being built up from rows: its
 *  blind index, whether the provider has refunded it, and the payment sessions
 *  seen so far. */
type ReferenceProgress = {
  heldRowSessionIds: string[];
  index: string;
  payment: PaymentReference;
  refunded: boolean;
  rowSessionIds: [string, ...string[]];
  sessionIds: string[];
};

/** In-progress refund references, keyed by stable provider identity. */
type ReferenceProgressByKey = Map<string, ReferenceProgress>;

const queryProcessedReferences = <Row>(
  attendeeIds: readonly number[],
  select: string,
  suffix = "",
): Promise<Row[]> =>
  querySelectedPaymentReferenceRows<Row>(
    attendeeIds,
    (idSlots) =>
      `SELECT ${select}
           FROM processed_payments
          WHERE attendee_id IN (${idSlots})
            AND payment_reference != ''
            AND payment_reference_index != ''
          ${suffix}`,
  );

const attendeeIdsOf = (
  attendees: readonly { readonly id: number }[],
): number[] => attendees.map((attendee) => attendee.id);

/** Attendees that have a durable indexed provider-payment row. */
export const attendeeIdsWithIndexedPaymentReferences = async (
  attendeeIds: readonly number[],
): Promise<Set<number>> =>
  new Set(
    (
      await queryProcessedReferences<PaymentReferenceAttendeeRow>(
        attendeeIds,
        "DISTINCT attendee_id",
      )
    ).map((row) => Number(row.attendee_id)),
  );

const realSessionIds = (row: PaymentReferenceRow): string[] =>
  isAnchorSession(row.payment_session_id) ? [] : [row.payment_session_id];

const heldRowSessionIds = (row: PaymentReferenceRow): string[] =>
  row.protected_state === CLAIM_MIRROR ? [row.payment_session_id] : [];

const addReference = (
  byReference: ReferenceProgressByKey,
  row: PaymentReferenceRow,
  payment: PaymentReference,
  index: string,
): void => {
  const sessionIds = realSessionIds(row);
  const held = heldRowSessionIds(row);
  const existing = byReference.get(index);
  if (existing) {
    existing.heldRowSessionIds.push(...held);
    existing.rowSessionIds.push(row.payment_session_id);
    existing.sessionIds.push(...sessionIds);
    existing.refunded ||= row.provider_refunded_at !== "";
  } else {
    byReference.set(index, {
      heldRowSessionIds: held,
      index,
      payment,
      refunded: row.provider_refunded_at !== "",
      rowSessionIds: [row.payment_session_id],
      sessionIds,
    });
  }
};

const asRefundReferences = async (
  byReference: ReferenceProgressByKey,
): Promise<RefundPaymentReference[]> =>
  await Promise.all(
    [...byReference.values()].map(async (data) => ({
      ...data.payment,
      heldRowSessionIds: data.heldRowSessionIds,
      index: data.index,
      matchingIndexes: await matchingPaymentReferenceIndexes(data.payment),
      // An anchor-only reference predates refund observation.
      refundState: refundStateOf({
        legacy: data.sessionIds.length === 0,
        refunded: data.refunded,
      }),
      rowSessionIds: data.rowSessionIds,
      sessionIds: data.sessionIds,
    })),
  );

/**
 * Refundable provider references for each attendee. New processed_payments rows
 * carry per-session references. An old PII-only reference becomes refundable
 * only after an attendee save materializes that one durable indexed anchor.
 * Other unindexed historical rows make the whole attendee set unavailable.
 */
export const getRefundPaymentReferences = async <
  Owner extends RefundPaymentReferenceOwner,
>(
  attendees: readonly Owner[],
  privateKey: CryptoKey,
): Promise<Map<number, RefundPaymentReferenceSet>> => {
  if (attendees.length === 0) return new Map();
  const byAttendee = new Map(
    attendees.map((attendee) => [
      attendee.id,
      new Map<string, ReferenceProgress>(),
    ]),
  );
  const rows = await loadSelectedPaymentReferenceRows(attendeeIdsOf(attendees));
  const incompleteAttendeeIds = new Set(
    rows
      .filter((row) => Number(row.unindexed_history) === 1)
      .map((row) => Number(row.attendee_id)),
  );
  for (const row of rows) {
    if (
      Number(row.unindexed_history) === 1 ||
      incompleteAttendeeIds.has(Number(row.attendee_id))
    ) {
      continue;
    }
    const { index, payment } = await loadIndexedPaymentReference(
      row,
      privateKey,
    );
    addReference(
      requiredMapValue(
        byAttendee,
        Number(row.attendee_id),
        `Payment reference attendee ${row.attendee_id} was not loaded`,
      ),
      row,
      payment,
      index,
    );
  }
  return new Map(
    await Promise.all(
      attendees.map(
        async (attendee): Promise<[number, RefundPaymentReferenceSet]> => {
          if (incompleteAttendeeIds.has(attendee.id)) {
            return [attendee.id, { kind: "legacy_unindexed" }];
          }
          const references = await asRefundReferences(
            requiredMapValue(
              byAttendee,
              attendee.id,
              `Refund references for attendee ${attendee.id} were not loaded`,
            ),
          );
          if (
            attendee.currentPaymentId !== "" &&
            !references.some(
              (reference) => reference.reference === attendee.currentPaymentId,
            )
          ) {
            return [attendee.id, { kind: "legacy_unindexed" }];
          }
          return [attendee.id, { kind: "complete", references }];
        },
      ),
    ),
  );
};

/** The complete refund set or old-history refusal for one attendee. */
export const getRefundPaymentReferencesForAttendee = async <
  Owner extends RefundPaymentReferenceOwner,
>(
  attendee: Owner,
  privateKey: CryptoKey,
): Promise<RefundPaymentReferenceSet> =>
  requiredMapValue(
    await getRefundPaymentReferences([attendee], privateKey),
    attendee.id,
    `Refund references for attendee ${attendee.id} were not loaded`,
  );

/**
 * Whether a refund run is still holding any of these charges' rows.
 *
 * Its hold refuses the attendee's delete and their merge, and only another run
 * can take it off — so a held attendee is work outstanding even when every
 * penny is already back.
 */
export const underRefundClaim = (
  references: readonly RefundPaymentReference[],
): boolean =>
  references.some((reference) => reference.heldRowSessionIds.length > 0);

/** Whether any of these charges may still be with the provider. */
export const stillWithTheProvider = (
  references: readonly RefundPaymentReference[],
): boolean => {
  const cameBack = references.some(
    (reference) => reference.refundState === "completed",
  );
  return references.some(
    (reference) =>
      reference.refundState === "none" ||
      (cameBack && reference.refundState === "unknown"),
  );
};

export const getAttendeeIdsWithPaymentReference = async (
  attendees: readonly RefundPaymentReferenceSource[],
): Promise<Set<number>> => {
  const ids = new Set(
    attendees
      .filter((attendee) => attendee.payment_id !== "")
      .map((attendee) => attendee.id),
  );
  const indexedIds = await attendeeIdsWithIndexedPaymentReferences(
    attendeeIdsOf(attendees),
  );
  for (const attendeeId of indexedIds) {
    ids.add(attendeeId);
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
): Promise<SqlStatement | null> => {
  if (sourcePaymentId === "") return null;
  const anchorReference = await paymentAnchorReference({
    kind: "untagged",
    reference: sourcePaymentId,
  });
  const { matchingIndexes, stored } = anchorReference;
  const matchingIndexSlots = inPlaceholders(matchingIndexes);
  return {
    args: [
      legacyMergeSessionId(sourceId),
      targetId,
      nowIso(),
      stored.encrypted,
      stored.index,
      sourceId,
      ...matchingIndexes,
    ],
    // A current checkout row already carries this charge and will move in the
    // same transaction. The anchor exists only for PII-only legacy payments.
    sql: `INSERT OR IGNORE INTO processed_payments
          (payment_session_id, attendee_id, processed_at, payment_reference,
           payment_reference_index)
          SELECT ?, ?, ?, ?, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM processed_payments AS payment
              WHERE payment.attendee_id = ?
                AND payment.payment_reference != ''
                AND payment.payment_reference_index IN (${matchingIndexSlots})
           )`,
  };
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
