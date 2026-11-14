/** The invoice table: one frozen rendered invoice per row. */

import { INVOICE_STATUSES } from "#shared/invoices/status.ts";
import { attendeeIdColumn } from "./columns.ts";
import { checked, defaulted, oneOf, rowId, text } from "./scalar-columns.ts";
import type { Table } from "./types.ts";
import { sql } from "#db/sql.ts";

export const invoiceTables: [name: string, table: Table][] = [
  [
    // An invoice belongs to one attendee. The body is the rendered Liquid
    // output, frozen when an operator creates the invoice. It is sealed under
    // a key that the share token and the site key derive. The token holder
    // reads the body, and a dump of the database alone opens nothing.
    // `share_token` holds that capability, sealed under the owner key for an
    // owner session. `share_token_index` finds the row without opening it.
    // No FK: the attendee delete path removes these rows explicitly, like
    // system_notes.
    "invoices",
    {
      columns: [
        // The operator-visible invoice number. A create form prefills the next
        // free number, and the database keeps it unique.
        ["id", rowId],
        attendeeIdColumn,
        ["body", checked(sql`body GLOB 'enc:1:?*'`)(text)],
        ["status", oneOf("status", INVOICE_STATUSES)(defaulted(text, "new"))],
        ["share_token", checked(sql`share_token GLOB 'hyb:1:?*'`)(text)],
        ["share_token_index", text],
        ["created", text],
      ],
      indexes: [
        {
          columns: ["attendee_id", "status"],
          name: "idx_invoices_attendee_status",
        },
        {
          columns: ["share_token_index"],
          name: "idx_invoices_share_token",
          unique: true,
        },
        // At most one new invoice per attendee. A new invoice must wait for
        // the open one to be cancelled, and the database holds that rule even
        // when two requests race.
        {
          columns: ["attendee_id"],
          name: "idx_invoices_open_attendee",
          unique: true,
          where: sql`status = 'new'`,
        },
      ],
    },
  ],
];
