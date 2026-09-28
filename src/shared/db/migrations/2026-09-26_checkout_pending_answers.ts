import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-09-26_checkout_pending_answers",
  "Stage a checkout's answers under the hash of its session id, sealed with the checkout work key, so the confirmation email can show them without the owner key",
  {
    indexes: [
      "idx_checkout_pending_answers_due",
      "idx_checkout_pending_answers_attendee",
    ],
    newTables: ["checkout_pending_answers"],
  },
);
