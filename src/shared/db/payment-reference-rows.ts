import { inPlaceholders, queryAll } from "#shared/db/client.ts";

export type PaymentReferenceRow = {
  attendee_id: number;
  payment_reference: string;
  payment_reference_index: string;
  payment_session_id: string;
  protected_state: string;
  provider_refunded_at: string;
  unindexed_history: number;
};

/** Run a payment-reference query only for the attendee ids it names. */
export const querySelectedPaymentReferenceRows = <Row>(
  attendeeIds: readonly number[],
  statement: (idSlots: string) => string,
): Promise<Row[]> =>
  attendeeIds.length === 0
    ? Promise.resolve([])
    : queryAll<Row>(statement(inPlaceholders(attendeeIds)), [...attendeeIds]);

/** Load indexed references for only the chosen attendees. One marker row per
 * attendee reports old history without reading its encrypted reference. */
export const loadSelectedPaymentReferenceRows = (
  attendeeIds: readonly number[],
): Promise<PaymentReferenceRow[]> =>
  querySelectedPaymentReferenceRows<PaymentReferenceRow>(
    attendeeIds,
    (idSlots) =>
      `WITH selectedPayment AS (
       SELECT attendee_id, payment_session_id, payment_reference,
              payment_reference_index, protected_state, provider_refunded_at,
              processed_at
         FROM processed_payments
        WHERE attendee_id IN (${idSlots})
          AND payment_reference != ''
     ), referenceRead AS (
       SELECT attendee_id, payment_session_id, payment_reference,
              payment_reference_index, protected_state, provider_refunded_at,
              processed_at, 0 AS unindexed_history
         FROM selectedPayment
        WHERE payment_reference_index != ''
       UNION ALL
       SELECT attendee_id, '', '', '', '', '', '', 1
         FROM selectedPayment
        WHERE payment_reference_index = ''
        GROUP BY attendee_id
     )
     SELECT attendee_id, payment_session_id, payment_reference,
            payment_reference_index, protected_state, provider_refunded_at,
            unindexed_history
       FROM referenceRead
      ORDER BY attendee_id, unindexed_history DESC, processed_at,
               payment_session_id`,
  );
