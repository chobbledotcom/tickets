import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-08-12_refund_confirmations",
  "Record refund confirmation replay identities and give app-written refund notes indexed names, so confirmation never scans encrypted history",
  {
    columns: { system_notes: ["system_name"] },
    indexes: [
      "idx_refund_confirmation_references_unique",
      "idx_refund_confirmations_attendee",
      "idx_system_notes_named_unique",
    ],
    newTables: ["refund_confirmations", "refund_confirmation_references"],
  },
);
