/** The invoice body: the facts it shows and the frozen HTML it produces. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { formatCurrency } from "#shared/currency.ts";
import {
  buildInvoiceBodyData,
  renderInvoiceBody,
} from "#shared/invoices/body.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const FACTS = {
  created: "2026-11-03T09:00:00.000Z",
  customer: { email: "buyer@example.com", name: "Ada Lovelace" },
  lines: [{ name: "Workshop", quantity: 2 }],
  number: 12,
  totals: { due: 1500, paid: 500, total: 2000 },
};

describeWithEnv("shared > invoice body", { db: true }, () => {
  test("builds the buyer's date, number, and labels", () => {
    const data = buildInvoiceBodyData(FACTS);
    expect(data.invoice).toEqual({
      date: "Tuesday 3 November 2026",
      number: 12,
    });
    expect(data.customer).toEqual(FACTS.customer);
    expect(data.lines).toEqual([{ name: "Workshop", quantity: 2 }]);
    expect(data.labels).toEqual({
      due: "Amount due",
      heading: "Invoice 12",
      item: "Item",
      paid: "Paid",
      quantity: "Quantity",
      total: "Total",
    });
  });

  test("renders the lines, the totals, and escaped buyer details", async () => {
    const html = await renderInvoiceBody(
      buildInvoiceBodyData({
        ...FACTS,
        customer: { email: "buyer@example.com", name: "Ada & Bob" },
      }),
    );

    expect(html).toContain("<h2>Invoice 12</h2>");
    expect(html).toContain("Tuesday 3 November 2026");
    expect(html).toContain("Ada &amp; Bob");
    expect(html).not.toContain("Ada & Bob");
    expect(html).toContain('<td style="padding:8px">Workshop</td>');
    expect(html).toContain('<td style="text-align:center;padding:8px">2</td>');
    expect(html).toContain(`Total: ${formatCurrency(2000)}`);
    expect(html).toContain(`Paid: ${formatCurrency(500)}`);
    expect(html).toContain(`Amount due: ${formatCurrency(1500)}`);
  });
});
