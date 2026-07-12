import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-07-12_checkout_stages",
  "Add checkout_stages so paid orders are stored at quantity zero before the buyer leaves for the payment provider and the same attendee can later be booked or retained after a refund.",
  {
    indexes: ["idx_checkout_stages_attendee_id"],
    newTables: ["checkout_stages"],
  },
);
