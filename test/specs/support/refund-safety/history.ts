/** Historical payment shapes used only after a real customer has paid. */

import { getAttendeeOrNull } from "#shared/db/attendees/queries.ts";
import { execute, queryAll } from "#shared/db/client.ts";
import { loadIndexedPaymentReference } from "#shared/db/payment-reference-store.ts";
import type { PaymentProviderType } from "#shared/types.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { historicalPaymentReferenceStorage } from "#test-utils/historical-payment-references.ts";

type StoredReferenceRow = {
  readonly payment_reference: string;
  readonly payment_reference_index: string;
  readonly payment_session_id: string;
  readonly protected_state: string;
  readonly refund_state_name: string | null;
};

type PaymentIdentity = {
  readonly provider: PaymentProviderType;
  readonly reference: string;
};

interface ModernPayment extends PaymentIdentity {
  readonly row: StoredReferenceRow;
}

type ReplacementReference = {
  readonly encrypted: string;
  readonly index: string;
};

type ChangePaymentHistory = (attendeeId: number) => Promise<PaymentIdentity>;

const paymentRowsFor = (attendeeId: number): Promise<StoredReferenceRow[]> =>
  queryAll<StoredReferenceRow>(
    `SELECT payment.payment_session_id, payment.payment_reference,
            payment.payment_reference_index, payment.protected_state,
            charge.refund_state_name
       FROM processed_payments AS payment
       LEFT JOIN payment_charges AS charge
         ON charge.reference_index = payment.payment_reference_index
      WHERE payment.attendee_id = ? AND payment.payment_reference != ''
      ORDER BY processed_at, payment_session_id`,
    [attendeeId],
  );

const oneModernPayment = async (attendeeId: number): Promise<ModernPayment> => {
  const privateKey = await getTestPrivateKey();
  const attendee = await getAttendeeOrNull(attendeeId, privateKey);
  if (attendee === null) throw new Error(`There is no booking ${attendeeId}`);
  const rows = await paymentRowsFor(attendeeId);
  const [row, extra] = rows;
  if (row === undefined || extra !== undefined) {
    throw new Error(
      `Historical setup expected one stored payment for booking ${attendeeId}, found ${rows.length}`,
    );
  }
  if (row.protected_state !== "" || row.refund_state_name !== null) {
    throw new Error(
      `Payment ${row.payment_session_id} already has live refund work`,
    );
  }
  const { payment } = await loadIndexedPaymentReference(row, privateKey);
  if (payment.kind !== "tagged") {
    throw new Error(`Payment ${row.payment_session_id} is already historical`);
  }
  if (attendee.payment_id !== payment.reference) {
    throw new Error(
      `Booking ${attendeeId} does not carry payment ${payment.reference}`,
    );
  }
  return { provider: payment.provider, reference: payment.reference, row };
};

const changeStoredPaymentReference =
  (
    replacementFor: (reference: string) => Promise<ReplacementReference>,
    change: string,
  ): ChangePaymentHistory =>
  async (attendeeId) => {
    const { provider, reference, row } = await oneModernPayment(attendeeId);
    const replacement = await replacementFor(reference);
    const result = await execute(
      `UPDATE processed_payments
        SET payment_reference = ?, payment_reference_index = ?
      WHERE payment_session_id = ?
        AND payment_reference = ?
        AND payment_reference_index = ?
        AND protected_state = ''
        AND NOT EXISTS (
          SELECT 1
            FROM payment_charges AS charge
           WHERE charge.reference_index = processed_payments.payment_reference_index
        )`,
      [
        replacement.encrypted,
        replacement.index,
        row.payment_session_id,
        row.payment_reference,
        row.payment_reference_index,
      ],
    );
    if (result.rowsAffected !== 1) {
      throw new Error(
        `Payment ${row.payment_session_id} changed while ${change}`,
      );
    }
    return { provider, reference };
  };

/**
 * Turn a just-completed booking into the oldest supported storage shape.
 *
 * Payments from before per-session references carry their raw charge only in
 * the attendee's encrypted PII. The customer journey must create the booking
 * first; this removes only the newer duplicate reference after verifying that
 * it describes the same charge and has no refund work attached.
 */
export const makeBookingPaymentHistorical: ChangePaymentHistory =
  changeStoredPaymentReference(
    () => Promise.resolve({ encrypted: "", index: "" }),
    "making it historical",
  );

/**
 * Keep the payment on its processed row but remove its provider tag.
 *
 * This represents the later historical shape whose charge was migrated into
 * encrypted reference storage before provider identity was recorded.
 */
export const forgetStoredPaymentProvider: ChangePaymentHistory =
  changeStoredPaymentReference(
    historicalPaymentReferenceStorage,
    "forgetting its provider",
  );
