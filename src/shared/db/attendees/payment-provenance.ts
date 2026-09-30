/** Atomic proof that an attendee's encrypted payment id has a stored source. */

import type { ResultSet } from "@libsql/client";
import type { SqlStatement } from "#db/client.ts";
import {
  numberedStatement,
  type SqlParameterToken,
} from "#db/numbered-statement.ts";

interface AttendeePaymentProvenance {
  /** Refuse a batch result that did not record exactly one attendee. */
  require(result: ResultSet, sessionId: string): void;
  /** Build the same write for an atomic statement batch. */
  statement(sessionId: string): SqlStatement;
}

/** Qualify one session as the provenance pointer for the attendee it paid.
 * Both the booking-time write and the legacy rebuild run this same rule. */
export const provenancePointerSql = (session: SqlParameterToken): string =>
  `UPDATE attendees
      SET pii_payment_session_id = ${session}
    WHERE pii_payment_session_id IS NULL
      AND id = (
        SELECT payment.attendee_id
          FROM processed_payments AS payment
         WHERE payment.payment_session_id = ${session}
           AND payment.attendee_id IS NOT NULL
           AND payment.payment_reference != ''
           AND payment.payment_reference_index != ''
      )`;

/** The provenance pointer write for one session, ready to run or batch. Both
 * the booking-time write and the legacy rebuild run this same rule. */
export const provenancePointerStatement = (sessionId: string): SqlStatement =>
  numberedStatement((bind) => provenancePointerSql(bind(sessionId)));

const requireRecorded = (result: ResultSet, sessionId: string): void => {
  if (result.rowsAffected !== 1) {
    throw new Error(
      `Payment session ${sessionId} could not prove its attendee payment id`,
    );
  }
};

/** Qualify a just-created attendee from its authoritative payment row. */
export const attendeePaymentProvenance: AttendeePaymentProvenance = {
  require: requireRecorded,
  statement: provenancePointerStatement,
};
