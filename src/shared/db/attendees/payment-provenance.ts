/** Atomic proof that an attendee's encrypted payment id has a stored source. */

import type { ResultSet } from "@libsql/client";

import { type Expr, equal, literal, notEqual } from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";
import type { SqlStatement } from "#db/sql.ts";
import { update } from "#db/write.ts";

interface AttendeePaymentProvenance {
  /** Refuse a batch result that did not record exactly one attendee. */
  require(result: ResultSet, sessionId: string): void;
  /** Build the same write for an atomic statement batch. */
  statement(sessionId: string): SqlStatement;
}

/** The attendee that a session paid, where the session holds a full payment
 *  reference. */
const paidAttendeeOf = (sessionId: string): Expr<number | null> =>
  from(tables.processed_payments)
    .as("payment")
    .where((payment) => [
      equal(payment.payment_session_id, sessionId),
      notEqual(payment.attendee_id, null),
      notEqual(payment.payment_reference, literal("")),
      notEqual(payment.payment_reference_index, literal("")),
    ])
    .scalar((payment) => payment.attendee_id);

/** Qualify one session as the provenance pointer for the attendee it paid.
 * Both the booking-time write and the legacy rebuild run this same rule. */
export const provenancePointerStatement = (sessionId: string): SqlStatement =>
  update(tables.attendees, { pii_payment_session_id: sessionId }).where(
    (attendee) => [
      equal(attendee.pii_payment_session_id, null),
      equal(paidAttendeeOf(sessionId), attendee.id),
    ],
  );

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
