/** Bounded, PII-free candidate admission for a listing-wide refund. */

/* jscpd:ignore-start -- imports */
import type { ResultSet } from "@libsql/client";
import type { OwnerKeyEncrypted } from "#shared/crypto/sealed.ts";
import { ATTENDEE_KIND } from "#shared/db/attendees/kind.ts";
import { refundedForBooking } from "#shared/db/attendees/select.ts";
import {
  queryBatchPrimary,
  resultRows,
  type SqlStatement,
} from "#shared/db/client.ts";
import { paymentAnchorSessionCondition } from "#shared/db/payment-anchor/session.ts";
import { refundAuthorityWorkSql } from "#shared/payment/refund-authority-lifecycle.ts";
import { requireValue } from "#shared/required-value.ts";

/* jscpd:ignore-end */

// One attendee's complete payment set is the largest command whose provider,
// authority, ledger, settlement, and route tail fit one edge request.
const REFUND_ALL_BATCH_SIZE = 1;

export type RefundAllCandidateAttendee = {
  readonly id: number;
  readonly pii_blob: OwnerKeyEncrypted;
  readonly quantity: 1;
  readonly refunded: boolean;
};

export type RefundAllSummary = {
  readonly blockedBy:
    | "legacy_unindexed"
    | "owner_review"
    | "provider_refund"
    | "unrecorded_money"
    | null;
  readonly total: number;
};

export type RefundAllBatch = RefundAllSummary & {
  readonly attendees: readonly RefundAllCandidateAttendee[];
};

type RefundAllSummaryRow = {
  legacy_unindexed: number;
  owner_review: number;
  provider_refund: number;
  total: number;
  unrecorded_money: number;
};

type RefundAllCandidateRow = {
  id: number;
  pii_blob: OwnerKeyEncrypted;
  refunded: number;
};

const refundStatus = refundedForBooking(
  "attendee.id",
  "listingAttendee.listing_id",
  "0",
);

const anchorSession = paymentAnchorSessionCondition(
  "payment.payment_session_id",
);
const providerRefundWork = refundAuthorityWorkSql("charge.");

/** Payment facts for real ticket holders on one listing. */
const refundCandidateCtes = (): string => `
  WITH bookingAttendee AS (
    SELECT attendee.id,
           MIN(${refundStatus}) AS refunded
      FROM attendees AS attendee
      JOIN listing_attendees AS listingAttendee
        ON listingAttendee.attendee_id = attendee.id
     WHERE attendee.kind = '${ATTENDEE_KIND}'
       AND listingAttendee.listing_id = ?
       AND listingAttendee.quantity > 0
     GROUP BY attendee.id
  ),
  paymentReference AS (
    SELECT payment.attendee_id,
           payment.payment_reference_index,
           MAX(CASE WHEN charge.refund_state_name = 'completed' THEN 1 ELSE 0 END)
             AS completed,
           MAX(CASE WHEN NOT ${anchorSession} THEN 1 ELSE 0 END)
             AS is_current,
           MAX(CASE WHEN payment.protected_state = 'claim' THEN 1 ELSE 0 END)
             AS has_claim,
           MAX(CASE WHEN payment.protected_state = 'review' THEN 1 ELSE 0 END)
             AS needs_review,
           MAX(CASE WHEN payment.protected_state = 'unrecorded' THEN 1 ELSE 0 END)
             AS needs_money_record,
           MAX(CASE WHEN payment.payment_reference_index = '' THEN 1 ELSE 0 END)
             AS legacy_unindexed,
           MAX(CASE WHEN ${providerRefundWork} THEN 1 ELSE 0 END)
             AS provider_refund
      FROM processed_payments AS payment
      JOIN bookingAttendee AS attendee
        ON attendee.id = payment.attendee_id
      LEFT JOIN payment_charges AS charge
        ON charge.reference_index = payment.payment_reference_index
     WHERE payment.payment_reference != ''
     GROUP BY payment.attendee_id,
              payment.payment_reference_index,
              CASE WHEN payment.payment_reference_index = ''
                   THEN payment.payment_session_id ELSE '' END
  ),
  paymentAttendee AS (
    SELECT paymentReference.attendee_id,
           MAX(paymentReference.completed) AS has_completed,
           MAX(paymentReference.has_claim) AS has_claim,
           MAX(paymentReference.needs_review) AS needs_review,
           MAX(paymentReference.needs_money_record) AS needs_money_record,
           MAX(paymentReference.provider_refund) AS provider_refund,
           MAX(paymentReference.legacy_unindexed) AS legacy_unindexed,
           MAX(
             CASE WHEN paymentReference.is_current = 1
                        AND paymentReference.completed = 0
                  THEN 1 ELSE 0 END
           ) AS has_current,
           MAX(
             CASE WHEN paymentReference.is_current = 0
                        AND paymentReference.completed = 0
                  THEN 1 ELSE 0 END
           ) AS has_unknown
      FROM paymentReference
     GROUP BY paymentReference.attendee_id
  ),
  refundable AS (
    SELECT attendee.id,
           attendee.refunded,
           payment.has_claim,
           payment.legacy_unindexed,
           payment.needs_review,
           payment.needs_money_record,
           payment.provider_refund
      FROM bookingAttendee AS attendee
      JOIN paymentAttendee AS payment ON payment.attendee_id = attendee.id
     WHERE attendee.refunded = 0
        OR payment.has_claim = 1
        OR payment.provider_refund = 1
        OR payment.has_current = 1
        OR (payment.has_completed = 1 AND payment.has_unknown = 1)
  )`;

const summaryStatement = (listingId: number): SqlStatement => ({
  args: [listingId],
  sql: `${refundCandidateCtes()}
    SELECT COUNT(*) AS total,
           COALESCE(MAX(refundable.legacy_unindexed), 0)
             AS legacy_unindexed,
           COALESCE(MAX(refundable.needs_review), 0) AS owner_review,
           COALESCE(MAX(refundable.provider_refund), 0) AS provider_refund,
           COALESCE(MAX(refundable.needs_money_record), 0)
             AS unrecorded_money
      FROM refundable`,
});

const batchStatement = (listingId: number): SqlStatement => ({
  args: [listingId, REFUND_ALL_BATCH_SIZE],
  sql: `${refundCandidateCtes()}
    , selectedAttendee AS (
      SELECT refundable.id, refundable.refunded, refundable.has_claim
        FROM refundable
       ORDER BY refundable.has_claim DESC, refundable.id ASC
       LIMIT ?
    )
    SELECT attendee.id, attendee.pii_blob, selectedAttendee.refunded
      FROM selectedAttendee
      JOIN attendees AS attendee ON attendee.id = selectedAttendee.id
     ORDER BY selectedAttendee.has_claim DESC, selectedAttendee.id ASC`,
});

const readSummary = (result: ResultSet): RefundAllSummary => {
  const row = requireValue(
    resultRows<RefundAllSummaryRow>(result)[0],
    "Refund All admission returned no summary",
  );
  const blockedBy = row.unrecorded_money
    ? "unrecorded_money"
    : row.provider_refund
    ? "provider_refund"
    : row.owner_review
    ? "owner_review"
    : row.legacy_unindexed
    ? "legacy_unindexed"
    : null;
  return { blockedBy, total: Number(row.total) };
};

const readAttendees = (result: ResultSet): RefundAllCandidateAttendee[] =>
  resultRows<RefundAllCandidateRow>(result).map((row) => ({
    id: Number(row.id),
    pii_blob: row.pii_blob,
    quantity: 1,
    refunded: Boolean(row.refunded),
  }));

/** Count the complete refundable set and report its visible send blockers. */
export const getRefundAllSummary = async (
  listingId: number,
): Promise<RefundAllSummary> => {
  const [summary] = await queryBatchPrimary([summaryStatement(listingId)]);
  return readSummary(
    requireValue(summary, "Refund All admission returned no result"),
  );
};

/** Check complete safety facts and select only one claim-first candidate batch. */
export const loadRefundAllBatch = async (
  listingId: number,
): Promise<RefundAllBatch> => {
  const [summary, attendees] = await queryBatchPrimary([
    summaryStatement(listingId),
    batchStatement(listingId),
  ]);
  return {
    ...readSummary(
      requireValue(summary, "Refund All admission returned no summary result"),
    ),
    attendees: readAttendees(
      requireValue(attendees, "Refund All admission returned no batch result"),
    ),
  };
};
