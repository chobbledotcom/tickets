import { OPEN_CHECKOUT_STAGE_SQL } from "#shared/db/checkout-stage-state.ts";
import type { Trigger } from "./types.ts";

const STAGE_COLUMNS = ["payment_session_id", "attendee_id", "state"] as const;

const REVISION_DEPENDENCIES = {
  checkout_stage_revisions: ["id", "revision"],
  checkout_stages: STAGE_COLUMNS,
};

const revisionTrigger = (action: "INSERT" | "UPDATE" | "DELETE"): Trigger => ({
  dependencies: REVISION_DEPENDENCIES,
  name: `trg_checkout_stages_revision_${action.toLowerCase()}`,
  sql: `CREATE TRIGGER IF NOT EXISTS trg_checkout_stages_revision_${action.toLowerCase()}
AFTER ${action} ON checkout_stages
FOR EACH ROW
BEGIN
  INSERT INTO checkout_stage_revisions (id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END`,
  table: "checkout_stages",
});

const PAYMENT_DEPENDENCIES = {
  checkout_stages: STAGE_COLUMNS,
  processed_payments: [
    "payment_session_id",
    "attendee_id",
    "checkout_stage_attendee_id",
  ],
};

/** Stable snapshots and rollback safety both depend on database-level fences:
 * old code cannot reserve around a staged attendee, and no payment can finish
 * an open stage onto a different attendee. */
export const CHECKOUT_STAGE_TRIGGERS: Trigger[] = [
  revisionTrigger("INSERT"),
  revisionTrigger("UPDATE"),
  revisionTrigger("DELETE"),
  {
    dependencies: PAYMENT_DEPENDENCIES,
    name: "trg_processed_payments_checkout_stage_claim_insert",
    sql: `CREATE TRIGGER IF NOT EXISTS trg_processed_payments_checkout_stage_claim_insert
BEFORE INSERT ON processed_payments
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM checkout_stages AS stage
   WHERE stage.payment_session_id = NEW.payment_session_id
     AND (NEW.checkout_stage_attendee_id IS NULL
       OR NEW.checkout_stage_attendee_id != stage.attendee_id)
)
BEGIN
  SELECT RAISE(ABORT, 'checkout stage claim does not match');
END`,
    table: "processed_payments",
  },
  {
    dependencies: PAYMENT_DEPENDENCIES,
    name: "trg_processed_payments_checkout_stage_finalize_insert",
    sql: `CREATE TRIGGER IF NOT EXISTS trg_processed_payments_checkout_stage_finalize_insert
BEFORE INSERT ON processed_payments
FOR EACH ROW
WHEN NEW.attendee_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM checkout_stages AS stage
   WHERE stage.payment_session_id = NEW.payment_session_id
     AND stage.state ${OPEN_CHECKOUT_STAGE_SQL}
     AND stage.attendee_id != NEW.attendee_id
)
BEGIN
  SELECT RAISE(ABORT, 'open checkout stage belongs to another attendee');
END`,
    table: "processed_payments",
  },
  {
    dependencies: PAYMENT_DEPENDENCIES,
    name: "trg_processed_payments_checkout_stage_finalize_update",
    sql: `CREATE TRIGGER IF NOT EXISTS trg_processed_payments_checkout_stage_finalize_update
BEFORE UPDATE OF attendee_id ON processed_payments
FOR EACH ROW
WHEN NEW.attendee_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM checkout_stages AS stage
   WHERE stage.payment_session_id = NEW.payment_session_id
     AND stage.state ${OPEN_CHECKOUT_STAGE_SQL}
     AND stage.attendee_id != NEW.attendee_id
)
BEGIN
  SELECT RAISE(ABORT, 'open checkout stage belongs to another attendee');
END`,
    table: "processed_payments",
  },
];
