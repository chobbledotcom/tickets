/** The migration that adds the invoice table. */

import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-11-03_invoices",
  "Add invoices. An operator creates one for an attendee with an outstanding balance, and it stores the rendered Liquid body as frozen HTML. The row carries a status and a non-expiring share token.",
  {
    indexes: [
      "idx_invoices_attendee_status",
      "idx_invoices_share_token",
      "idx_invoices_open_attendee",
    ],
    newTables: ["invoices"],
  },
);
