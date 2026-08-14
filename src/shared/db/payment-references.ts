/**
 * Provider payment references used by admin refunds.
 *
 * Stored references are owner-key encrypted: checkout/webhook code can write them
 * with the public key, and admin refund routes decrypt them only inside an
 * authenticated request.
 */

import { requiredMapValue } from "#fp";
/* jscpd:ignore-start */
import { isAnchorSession } from "#shared/db/payment-anchor/session.ts";
import {
  loadSelectedPaymentReferenceRows,
  MAX_REFUND_REFERENCES_PER_ATTENDEE,
  type PaymentReferenceRow,
  querySelectedPaymentReferenceRows,
} from "#shared/db/payment-reference-rows.ts";
import {
  loadIndexedPaymentReference,
  matchingPaymentReferenceIndexes,
} from "#shared/db/payment-reference-store.ts";
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

/** A provider-tagged identity admitted to automatic refund work. */
export type TaggedRefundPaymentReference = Extract<
  RefundPaymentReference,
  { kind: "tagged" }
>;

/** Why historical rows prevent a complete, provider-tagged reference set. */
export type RefundReferenceProblem = {
  readonly kind:
    | "legacy_unindexed"
    | "provider_unknown"
    | "too_many_references";
};

/** One attendee's complete refundable identities, or proof that old rows make
 * the set incomplete. No caller may receive the visible subset in the latter
 * case. */
export type RefundPaymentReferenceSet =
  | {
      readonly kind: "complete";
      readonly references: TaggedRefundPaymentReference[];
    }
  | RefundReferenceProblem;

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

const attendeeIdSet = (
  rows: readonly PaymentReferenceAttendeeRow[],
): Set<number> => new Set(rows.map((row) => Number(row.attendee_id)));

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
  attendeeIdSet(
    await queryProcessedReferences<PaymentReferenceAttendeeRow>(
      attendeeIds,
      "DISTINCT attendee_id",
    ),
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
    existing.refunded ||= row.refund_state_name === "completed";
  } else {
    byReference.set(index, {
      heldRowSessionIds: held,
      index,
      payment,
      refunded: row.refund_state_name === "completed",
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

const providersAreKnown = (
  references: readonly RefundPaymentReference[],
): references is TaggedRefundPaymentReference[] =>
  references.every((reference) => reference.kind === "tagged");

/**
 * Refundable provider references for each attendee. New processed_payments rows
 * carry per-session provider-tagged references. Indexed-but-untagged history
 * and unindexed historical rows remain unavailable to automatic money work.
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
  const incompleteAttendeeIds = attendeeIdSet(
    rows.filter((row) => Number(row.unindexed_history) === 1),
  );
  const oversizedAttendeeIds = attendeeIdSet(
    rows.filter(
      (row) =>
        Number(row.reference_number) > MAX_REFUND_REFERENCES_PER_ATTENDEE,
    ),
  );
  for (const row of rows) {
    if (
      Number(row.unindexed_history) === 1 ||
      incompleteAttendeeIds.has(Number(row.attendee_id)) ||
      oversizedAttendeeIds.has(Number(row.attendee_id))
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
          if (oversizedAttendeeIds.has(attendee.id)) {
            return [attendee.id, { kind: "too_many_references" }];
          }
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
          if (!providersAreKnown(references)) {
            return [attendee.id, { kind: "provider_unknown" }];
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
