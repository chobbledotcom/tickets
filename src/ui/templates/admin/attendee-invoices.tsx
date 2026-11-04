/** The attendee page's Invoice tab: one line per invoice, with its status. */

/* jscpd:ignore-start -- imports */
import type { InvoiceSummary } from "#db/invoices.ts";
import { t } from "#i18n";
import { adminPath } from "#shared/admin-surface.ts";
import { formatDateLabel } from "#shared/date-labels.ts";
import { INVOICE_STATUS_LABEL_KEYS } from "#shared/invoices/status.ts";
/* jscpd:ignore-end */

/** Every invoice the attendee has, newest first. The tab only renders for an
 *  attendee with at least one, and each line links to the invoice itself. */
export const AttendeeInvoicesList = ({
  invoices,
}: {
  invoices: InvoiceSummary[];
}): JSX.Element => (
  <ul class="prose">
    {invoices.map((invoice) => (
      <li>
        <a href={adminPath("invoice", { id: invoice.id })}>
          {t("invoices.column.number")} {invoice.id}
        </a>{" "}
        — {t(INVOICE_STATUS_LABEL_KEYS[invoice.status])} —{" "}
        {formatDateLabel(invoice.created.slice(0, 10))}
      </li>
    ))}
  </ul>
);
