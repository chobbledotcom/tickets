/** The unread-field exemptions for the invoice body and its share index.
 *  They live apart from exemptions.ts, which stays under its length limit. */

import type { Step } from "#scripts/unread-fields/fields/steps.ts";
import {
  type ExemptionReason,
  exemptFieldsUnder,
  type FindingExemption,
} from "#scripts/unread-fields/policy.ts";

const BODY_SOURCE = "src/shared/invoices/body.ts";
const ROW_SOURCE = "src/shared/db/invoices.ts";

/** The body is the data that its Liquid template renders. */
const liquidReason: ExemptionReason = {
  evidence:
    "renderInvoiceBody renders each invoice body field by its Liquid template name",
  kind: "dynamic-read",
};

/** Every body field the Liquid template reads, under its owner's path. */
const BODY_FIELD_GROUPS: readonly {
  fields: readonly string[];
  path: readonly Step[];
}[] = [
  {
    fields: ["customer", "invoice", "labels", "lines", "totals"],
    path: [],
  },
  { fields: ["email", "name"], path: [{ name: "customer" }] },
  { fields: ["date", "number"], path: [{ name: "invoice" }] },
  {
    fields: ["due", "heading", "item", "paid", "quantity", "total"],
    path: [{ name: "labels" }],
  },
  { fields: ["due", "paid", "total"], path: [{ name: "totals" }] },
];

export const INVOICE_EXEMPTIONS: readonly FindingExemption[] = [
  ...BODY_FIELD_GROUPS.flatMap(({ fields, path }) =>
    exemptFieldsUnder(
      [[BODY_SOURCE, [{ name: "InvoiceBodyData" }, ...path]]],
      fields,
      liquidReason,
    ),
  ),
  ...exemptFieldsUnder(
    [[ROW_SOURCE, [{ name: "InvoiceRow" }]]],
    ["share_token_index"],
    {
      evidence:
        "getInvoiceByShareToken passes the blind index as the table reader's query key, which becomes the lookup WHERE clause",
      kind: "schema-driven",
    },
  ),
];
