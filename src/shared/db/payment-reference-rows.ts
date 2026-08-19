import { inPlaceholders, queryAll } from "#db/client.ts";

/** Maximum payment-reference rows one attendee refund may open. */
export const MAX_REFUND_REFERENCES_PER_ATTENDEE = 10;

export type PaymentReferenceRow = {
  attendee_id: number;
  payment_reference: string;
  payment_reference_index: string;
  payment_session_id: string;
  protected_state: string;
  reference_number: number;
  refund_state_name: string | null;
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
              payment_reference_index, protected_state,
              charge.refund_state_name, processed_at
         FROM processed_payments AS payment
         LEFT JOIN payment_charges AS charge
           ON charge.reference_index = payment.payment_reference_index
        WHERE payment.attendee_id IN (${idSlots})
          AND payment.payment_reference != ''
     ), numberedReference AS (
       SELECT attendee_id, payment_session_id, payment_reference,
              payment_reference_index, protected_state, refund_state_name,
              processed_at,
              ROW_NUMBER() OVER (
                PARTITION BY attendee_id
                ORDER BY processed_at, payment_session_id
              ) AS reference_number
         FROM selectedPayment
        WHERE payment_reference_index != ''
     ), referenceRead AS (
       SELECT attendee_id, payment_session_id, payment_reference,
              payment_reference_index, protected_state, refund_state_name,
              processed_at, 0 AS unindexed_history, reference_number
         FROM numberedReference
        WHERE reference_number <= ${MAX_REFUND_REFERENCES_PER_ATTENDEE + 1}
       UNION ALL
       SELECT attendee_id, '', '', '', '', NULL, '', 1, 0
         FROM selectedPayment
        WHERE payment_reference_index = ''
        GROUP BY attendee_id
     )
     SELECT attendee_id, payment_session_id, payment_reference,
            payment_reference_index, protected_state, refund_state_name,
            unindexed_history, reference_number
       FROM referenceRead
      ORDER BY attendee_id, unindexed_history DESC, processed_at,
               payment_session_id`,
  );
