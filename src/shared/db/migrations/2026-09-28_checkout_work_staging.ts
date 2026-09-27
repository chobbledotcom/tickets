import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-09-28_checkout_work_staging",
  "Add private checkout work and provider cancellation state. Refuse an old staged row because its Square link identity cannot be recovered without risking an unpaid checkout.",
  {
    columns: {
      checkout_pending_answers: [
        "wrapped_key",
        "provider",
        "state",
        "next_check_at",
        "claim_token",
        "attendee_id",
      ],
    },
    indexes: [
      "idx_checkout_pending_answers_due",
      "idx_checkout_pending_answers_attendee",
    ],
  },
  async ({ getDb }) => {
    const old = await getDb().execute(
      "SELECT 1 FROM checkout_pending_answers WHERE wrapped_key = '' LIMIT 1",
    );
    if (old.rows.length !== 0) {
      throw new Error(
        "Cannot migrate checkout_pending_answers while legacy staged rows exist. Preserve and reconcile their payable checkouts before deploying CHECKOUT_WORK_KEY; no staged answer was deleted.",
      );
    }
  },
);
