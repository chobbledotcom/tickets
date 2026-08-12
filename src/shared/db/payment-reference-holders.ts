/** Authenticated preparation of every durable holder of refundable money. */

/* jscpd:ignore-start -- imports */
import type { OwnerKeyEncrypted } from "#shared/crypto/sealed.ts";
import { decryptPiiBlob } from "#shared/db/attendees/pii.ts";
import {
  resultRows,
  type SqlStatement,
  type TxScope,
  withTransaction,
} from "#shared/db/client.ts";
import { anchorSessionId } from "#shared/db/payment-anchor/session.ts";
import {
  loadIndexedPaymentReference,
  storePaymentReference,
} from "#shared/db/payment-reference-store.ts";
import { nowIso } from "#shared/now.ts";
import type { PaymentReference } from "#shared/payment/provider-reference.ts";

/* jscpd:ignore-end */

type StoredReferenceRow = {
  attendee_id: number | null;
  payment_reference: string;
  payment_reference_index: string;
  payment_session_id: string;
};

type StoredAttendeePii = {
  id: number;
  pii_blob: OwnerKeyEncrypted;
};

type PreparedReferenceRow = {
  attendeeId: number;
  index: string;
  payment: PaymentReference;
  sessionId: string;
};

const storedReferenceRows = async (
  tx: TxScope,
): Promise<StoredReferenceRow[]> =>
  resultRows<StoredReferenceRow>(
    await tx.execute(
      `SELECT payment.payment_session_id, payment.attendee_id,
              payment.payment_reference, payment.payment_reference_index
         FROM processed_payments AS payment
        WHERE payment.payment_reference != ''`,
    ),
  );

const prepareStoredRow = async (
  row: StoredReferenceRow,
  privateKey: CryptoKey,
): Promise<PreparedReferenceRow> => {
  if (row.attendee_id === null) {
    throw new Error(
      `Payment reference ${row.payment_session_id} has no attendee`,
    );
  }
  const { index, payment } = await loadIndexedPaymentReference(row, privateKey);
  return {
    attendeeId: Number(row.attendee_id),
    index,
    payment,
    sessionId: row.payment_session_id,
  };
};

const missingIndexStatement = (
  stored: StoredReferenceRow,
  prepared: PreparedReferenceRow,
): SqlStatement | null =>
  stored.payment_reference_index === ""
    ? {
        args: [
          prepared.index,
          stored.payment_session_id,
          stored.payment_reference,
        ],
        sql: `UPDATE processed_payments
                 SET payment_reference_index = ?
               WHERE payment_session_id = ?
                 AND payment_reference = ?
                 AND payment_reference_index = ''`,
      }
    : null;

const attendeePiiRows = async (tx: TxScope): Promise<StoredAttendeePii[]> =>
  resultRows<StoredAttendeePii>(
    await tx.execute(
      `SELECT attendee.id, attendee.pii_blob
         FROM attendees AS attendee`,
    ),
  );

const alreadyRepresented = (
  rows: readonly PreparedReferenceRow[],
  attendeeId: number,
  reference: string,
): boolean =>
  rows.some(
    (row) =>
      row.attendeeId === attendeeId && row.payment.reference === reference,
  );

const legacyAnchor = async (
  attendee: StoredAttendeePii,
  reference: string,
): Promise<SqlStatement> => {
  const payment = { kind: "untagged", reference } as const;
  const stored = await storePaymentReference(payment);
  const sessionId = anchorSessionId(attendee.id, stored.index);
  return {
    args: [
      sessionId,
      attendee.id,
      nowIso(),
      stored.encrypted,
      stored.index,
      attendee.id,
      attendee.pii_blob,
    ],
    // The PII comparison keeps a concurrent payment-id edit from anchoring
    // stale money. The deterministic key makes concurrent preparations one
    // row without hiding any other constraint failure.
    sql: `INSERT INTO processed_payments
            (payment_session_id, attendee_id, processed_at, payment_reference,
             payment_reference_index)
            SELECT ?, ?, ?, ?, ?
             WHERE EXISTS (
               SELECT 1 FROM attendees AS attendee
                WHERE attendee.id = ? AND attendee.pii_blob = ?
             )
                ON CONFLICT (payment_session_id) DO NOTHING`,
  };
};

const missingLegacyAnchors = async (
  attendees: readonly StoredAttendeePii[],
  rows: readonly PreparedReferenceRow[],
  privateKey: CryptoKey,
): Promise<SqlStatement[]> => {
  const paymentIds = await Promise.all(
    attendees.map(async (attendee) => ({
      attendee,
      paymentId: (await decryptPiiBlob(attendee.pii_blob, privateKey, true))
        .payment_id,
    })),
  );
  return await Promise.all(
    paymentIds
      .filter(
        ({ attendee, paymentId }) =>
          paymentId !== "" && !alreadyRepresented(rows, attendee.id, paymentId),
      )
      .map(({ attendee, paymentId }) => legacyAnchor(attendee, paymentId)),
  );
};

/**
 * Fill every old blind index and give every encrypted legacy payment id a row
 * before a refund snapshot is loaded. This global authenticated pass closes
 * the hole where the selected attendee had no way to see another attendee's
 * row-less copy of the same charge.
 */
export const prepareRefundReferenceHolders = (
  privateKey: CryptoKey,
): Promise<void> =>
  withTransaction(async (tx) => {
    const stored = await storedReferenceRows(tx);
    const prepared = await Promise.all(
      stored.map((row) => prepareStoredRow(row, privateKey)),
    );
    const anchors = await missingLegacyAnchors(
      await attendeePiiRows(tx),
      prepared,
      privateKey,
    );
    const statements = [
      ...stored.flatMap((row, index) => {
        const statement = missingIndexStatement(row, prepared[index]!);
        return statement === null ? [] : [statement];
      }),
      ...anchors,
    ];
    if (statements.length > 0) await tx.batch(statements);
  });
