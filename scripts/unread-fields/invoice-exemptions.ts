/** The unread-field exemptions for the invoice body and its share index.
 *  They live apart from exemptions.ts, which stays under its length limit. */

import { identitiesAt } from "#scripts/unread-fields/identity.ts";
import type {
  ExemptionReason,
  FindingExemption,
} from "#scripts/unread-fields/policy.ts";

const BODY_SOURCE = "src/shared/invoices/body.ts";
const ROW_SOURCE = "src/shared/db/invoices.ts";

/** Exempt one set of fields under one owner with one reason. */
const exemptAt = (
  source: string,
  path: readonly { name: string }[],
  fields: readonly string[],
  reason: ExemptionReason,
): FindingExemption[] =>
  identitiesAt([[source, path]])(fields).map((identity) => ({
    identity,
    reason,
  }));

/** The body is the data that its Liquid template renders. */
const liquidReason: ExemptionReason = {
  evidence:
    "renderInvoiceBody renders each invoice body field by its Liquid template name",
  kind: "dynamic-read",
};

export const INVOICE_EXEMPTIONS: readonly FindingExemption[] = [
  ...exemptAt(
    BODY_SOURCE,
    [{ name: "InvoiceBodyData" }],
    ["customer", "invoice", "labels", "lines", "totals"],
    liquidReason,
  ),
  ...exemptAt(
    BODY_SOURCE,
    [{ name: "InvoiceBodyData" }, { name: "customer" }],
    ["email", "name"],
    liquidReason,
  ),
  ...exemptAt(
    BODY_SOURCE,
    [{ name: "InvoiceBodyData" }, { name: "invoice" }],
    ["date", "number"],
    liquidReason,
  ),
  ...exemptAt(
    BODY_SOURCE,
    [{ name: "InvoiceBodyData" }, { name: "labels" }],
    ["due", "heading", "item", "paid", "quantity", "total"],
    liquidReason,
  ),
  ...exemptAt(
    BODY_SOURCE,
    [{ name: "InvoiceBodyData" }, { name: "totals" }],
    ["due", "paid", "total"],
    liquidReason,
  ),
  ...exemptAt(ROW_SOURCE, [{ name: "InvoiceRow" }], ["share_token_index"], {
    evidence:
      "getInvoiceByShareToken passes the blind index as the table reader's query key, which becomes the lookup WHERE clause",
    kind: "schema-driven",
  }),
];
