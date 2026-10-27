import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-10-27_booking_tax_assessments",
  "Store each booking's original listed basis and tax assessment revisions. Existing money remains unchanged.",
  {
    indexes: [
      "idx_booking_tax_assessments_revision",
      "idx_booking_tax_assessments_event",
      "idx_booking_tax_assessments_attendee",
    ],
    newTables: ["booking_tax_assessments"],
  },
);
