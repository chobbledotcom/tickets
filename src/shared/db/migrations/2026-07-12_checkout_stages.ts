import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-07-12_checkout_stages",
  "Add checkout stages so paid orders stay at quantity zero before payment, backups can certify a stable stage snapshot, and payment reservations cannot finish onto another attendee.",
  {
    columns: {
      processed_payments: ["checkout_stage_attendee_id"],
    },
    indexes: [
      "idx_checkout_stages_attendee_id",
      "idx_checkout_stages_state_created_at",
    ],
    newTables: ["checkout_stage_revisions", "checkout_stages"],
    triggers: [
      "trg_checkout_stages_revision_insert",
      "trg_checkout_stages_revision_update",
      "trg_checkout_stages_revision_delete",
      "trg_processed_payments_checkout_stage_claim_insert",
      "trg_processed_payments_checkout_stage_finalize_insert",
      "trg_processed_payments_checkout_stage_finalize_update",
    ],
  },
  async ({ getDb }) => {
    await getDb().execute(`UPDATE processed_payments
      SET checkout_stage_attendee_id = (
        SELECT stage.attendee_id FROM checkout_stages AS stage
         WHERE stage.payment_session_id = processed_payments.payment_session_id
      )
      WHERE EXISTS (
        SELECT 1 FROM checkout_stages AS stage
         WHERE stage.payment_session_id = processed_payments.payment_session_id
      )`);
  },
);
