/** The three invoice statuses, as one schema every consumer reads. */

import * as v from "valibot";

/** An invoice is new until it is cancelled or the attendee pays it. */
export const InvoiceStatusSchema = v.picklist(["new", "cancelled", "paid"]);

export type InvoiceStatus = v.InferOutput<typeof InvoiceStatusSchema>;

export const INVOICE_STATUSES = InvoiceStatusSchema.options;

/** The copy key that names each status to a person. Exhaustive by type. */
export const INVOICE_STATUS_LABEL_KEYS: Record<InvoiceStatus, string> = {
  cancelled: "invoices.status.cancelled",
  new: "invoices.status.new",
  paid: "invoices.status.paid",
};
