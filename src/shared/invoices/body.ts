/** The data an invoice body renders from, and the one render into HTML. */

import { t } from "#i18n";
import { formatDateLabel } from "#shared/date-labels.ts";
import type { LineItem } from "#shared/line-item.ts";
import { htmlLiquidEngine } from "#shared/liquid-engine.ts";
import { INVOICE_BODY_TEMPLATE } from "#templates/invoice/defaults.ts";

export type InvoiceBodyData = {
  customer: { email: string; name: string };
  invoice: { date: string; number: number };
  labels: {
    due: string;
    heading: string;
    item: string;
    paid: string;
    quantity: string;
    total: string;
  };
  lines: LineItem[];
  totals: { due: number; paid: number; total: number };
};

export type InvoiceBodyFacts = {
  created: string;
  customer: InvoiceBodyData["customer"];
  lines: LineItem[];
  number: number;
  totals: InvoiceBodyData["totals"];
};

/** Build the Liquid data from the facts the buyer sees. */
export const buildInvoiceBodyData = ({
  created,
  customer,
  lines,
  number,
  totals,
}: InvoiceBodyFacts): InvoiceBodyData => ({
  customer,
  invoice: {
    date: formatDateLabel(created.slice(0, 10)),
    number,
  },
  labels: {
    due: t("invoices.body.due"),
    heading: t("invoices.body.heading", { number }),
    item: t("invoices.body.item"),
    paid: t("invoices.body.paid"),
    quantity: t("invoices.body.quantity"),
    total: t("invoices.body.total"),
  },
  lines,
  totals,
});

/** Render the frozen HTML body. Every value is HTML-escaped. */
export const renderInvoiceBody = async (
  data: InvoiceBodyData,
): Promise<string> =>
  (await htmlLiquidEngine().parseAndRender(INVOICE_BODY_TEMPLATE, data)).trim();
