/** The invoice body: the facts it shows and the frozen HTML it produces. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { formatCurrency } from "#shared/currency.ts";
import {
  buildInvoiceBodyData,
  renderInvoiceBody,
  renderInvoiceText,
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

  test("fills the Markdown text with the lines and the totals", async () => {
    const text = await renderInvoiceText(buildInvoiceBodyData(FACTS));

    expect(text).toContain("# Invoice 12");
    expect(text).toContain("Tuesday 3 November 2026");
    expect(text).toContain("Ada Lovelace");
    expect(text).toContain("buyer@example.com");
    expect(text).toContain("| Workshop | 2 |");
    expect(text).toContain(`Total: ${formatCurrency(2000)}`);
    expect(text).toContain(`Paid: ${formatCurrency(500)}`);
    expect(text).toContain(`**Amount due: ${formatCurrency(1500)}**`);
  });

  test("renders the operator's text as safe HTML", () => {
    const html = renderInvoiceBody(
      [
        "# Invoice 12",
        "",
        "| Item | Quantity |",
        "| --- | --- |",
        "| Workshop | 2 |",
        "",
        "**Amount due: £15.00**",
      ].join("\n"),
    );

    expect(html).toContain("<h1>Invoice 12</h1>");
    expect(html).toContain("<td>Workshop</td>");
    expect(html).toContain("<strong>Amount due: £15.00</strong>");
  });

  test("escapes HTML a person typed into the text", () => {
    const html = renderInvoiceBody(
      "# Invoice 12\n\nAda & Bob <script>x</script>",
    );

    expect(html).toContain("Ada &amp; Bob");
    expect(html).not.toContain("<script>");
  });
});
