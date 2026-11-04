/** The public invoice page a share link opens. */

import type { InvoiceRow } from "#db/invoices.ts";
import { t } from "#i18n";
import { Raw } from "#jsx/jsx-runtime.ts";
import { INVOICE_STATUS_LABEL_KEYS } from "#shared/invoices/status.ts";
import { PayBalanceForm } from "#templates/public/balance.tsx";
import { prosePage } from "#templates/public/prose-page.tsx";

/** Render the frozen invoice body, its live status, and a pay form while the
 *  invoice is new and the attendee still owes money. The body holds the page's
 *  headings, so it controls them. */
export const invoiceSharePage = ({
  amount,
  body,
  invoice,
  payToken,
}: {
  amount: number;
  body: string;
  invoice: InvoiceRow;
  payToken: string | null;
}): string =>
  prosePage(
    t("invoices.share.title", { number: invoice.id }),
    // The frozen body brings its own heading.
    null,
  )(
    <>
      <Raw html={body} />
      <p>
        {t("invoices.share.status", {
          status: t(INVOICE_STATUS_LABEL_KEYS[invoice.status]),
        })}
      </p>
    </>,
    payToken === null ? null : (
      <p class="actions">
        <PayBalanceForm amount={amount} token={payToken} />
      </p>
    ),
  );
