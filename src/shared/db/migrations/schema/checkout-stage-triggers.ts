/** Triggers that track every checkout-stage change with one revision number. */

import type { Trigger } from "./types.ts";

const CHECKOUT_STAGE_REVISION_USES = {
  checkout_stage_revisions: ["id", "revision"],
  checkout_stages: [],
} as const;

const revisionTrigger = (action: "INSERT" | "UPDATE" | "DELETE"): Trigger => {
  const name = `trg_checkout_stages_revision_${action.toLowerCase()}`;
  return {
    name,
    sql: `CREATE TRIGGER IF NOT EXISTS ${name}
AFTER ${action} ON checkout_stages
FOR EACH ROW
BEGIN
  INSERT INTO checkout_stage_revisions (id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END`,
    table: "checkout_stages",
    uses: CHECKOUT_STAGE_REVISION_USES,
  };
};

export const CHECKOUT_STAGE_REVISION_TRIGGERS: Trigger[] = [
  revisionTrigger("INSERT"),
  revisionTrigger("UPDATE"),
  revisionTrigger("DELETE"),
];

/** A stage remains open while payment may still book it or its refund must
 * finish. Keep the lifecycle boundary beside every payment fence that uses it. */
const OPEN_CHECKOUT_STAGE_SQL = "IN ('pending', 'refunding')";

const CHECKOUT_STAGE_PAYMENT_FENCE_USES = {
  checkout_stages: ["payment_session_id", "attendee_id", "state"],
  processed_payments: [
    "payment_session_id",
    "attendee_id",
    "checkout_stage_attendee_id",
  ],
} as const;

export const CHECKOUT_STAGE_PAYMENT_FENCE_TRIGGERS: Trigger[] = [
  {
    name: "trg_processed_payments_checkout_stage_claim_insert",
    sql: `CREATE TRIGGER IF NOT EXISTS trg_processed_payments_checkout_stage_claim_insert
BEFORE INSERT ON processed_payments
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'checkout stage claim does not match')
  WHERE EXISTS (
  SELECT 1 FROM checkout_stages AS stage
  WHERE stage.payment_session_id = NEW.payment_session_id
    AND (NEW.checkout_stage_attendee_id IS NULL
      OR NEW.checkout_stage_attendee_id != stage.attendee_id)
  );
  SELECT RAISE(ABORT, 'open checkout stage belongs to another attendee')
  WHERE NEW.attendee_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM checkout_stages AS stage
    WHERE stage.payment_session_id = NEW.payment_session_id
      AND stage.state ${OPEN_CHECKOUT_STAGE_SQL}
      AND (NEW.checkout_stage_attendee_id IS NULL
        OR NEW.checkout_stage_attendee_id != stage.attendee_id
        OR stage.attendee_id != NEW.attendee_id)
  );
END`,
    table: "processed_payments",
    uses: CHECKOUT_STAGE_PAYMENT_FENCE_USES,
  },
  {
    name: "trg_processed_payments_checkout_stage_finalize_update",
    sql: `CREATE TRIGGER IF NOT EXISTS trg_processed_payments_checkout_stage_finalize_update
BEFORE UPDATE OF attendee_id ON processed_payments
FOR EACH ROW
WHEN NEW.attendee_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM checkout_stages AS stage
  WHERE stage.payment_session_id = NEW.payment_session_id
    AND stage.state ${OPEN_CHECKOUT_STAGE_SQL}
    AND (NEW.checkout_stage_attendee_id IS NULL
      OR NEW.checkout_stage_attendee_id != stage.attendee_id
      OR stage.attendee_id != NEW.attendee_id)
)
BEGIN
  SELECT RAISE(ABORT, 'open checkout stage belongs to another attendee');
END`,
    table: "processed_payments",
    uses: CHECKOUT_STAGE_PAYMENT_FENCE_USES,
  },
];
