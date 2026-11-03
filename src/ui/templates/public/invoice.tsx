/** The public invoice page a share link opens. */

import type { InvoiceRow } from "#db/invoices.ts";
import { t } from "#i18n";
import { Raw } from "#jsx/jsx-runtime.ts";
import { INVOICE_STATUS_LABEL_KEYS } from "#shared/invoices/status.ts";
import { ActionButton } from "#templates/components/actions.tsx";
import { prosePage } from "#templates/public/prose-page.tsx";

/** Render the frozen invoice body, its live status, and a pay link while the
 *  invoice is new and the attendee still owes money. */
export const invoiceSharePage = ({
  body,
  invoice,
  payToken,
}: {
  body: string;
  invoice: InvoiceRow;
  payToken: string | null;
}): string =>
  prosePage(
    t("invoices.share.title", { number: invoice.id }),
    t("invoices.share.heading", { number: invoice.id }),
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
        <ActionButton href={`/pay/${encodeURIComponent(payToken)}`}>
          {t("invoices.share.pay")}
        </ActionButton>
      </p>
    ),
  );
