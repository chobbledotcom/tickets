import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { formatCurrency } from "#shared/currency.ts";
import { RenewalTierSummary } from "#templates/admin/built-sites/renewal-summary.tsx";
import { testListingWithCount } from "#test-utils/factories.ts";

describe("RenewalTierSummary", () => {
  test("renders the complete empty-tier warning without a table", () => {
    const html = String(<RenewalTierSummary tiers={[]} />);

    expect(html).toBe(
      '<section><h2>Renewal tiers</h2><div class="error">No renewal tier listing is configured. Customers won\'t be able to renew their sites until you create one (a no-check-in, hidden listing with &lt;em&gt;Months per unit&lt;/em&gt; &gt; 0).</div></section>',
    );
  });

  test("renders each populated and zero tier value", () => {
    const html = String(
      <RenewalTierSummary
        tiers={[
          testListingWithCount({
            attendee_count: 7,
            id: 41,
            months_per_unit: 3,
            name: "Starter <Tier>",
            unit_price: 1250,
          }),
          testListingWithCount({
            attendee_count: 0,
            id: 42,
            months_per_unit: 12,
            name: "Free tier",
            unit_price: 0,
          }),
        ]}
      />,
    );

    expect(html).toContain(
      '<th>Tier</th><th class="col-quantity">Months per unit</th><th class="col-amount">Unit price</th><th class="col-quantity">Units sold</th>',
    );
    expect(html).toContain(
      `<tr><td><a href="/admin/listing/41">Starter &lt;Tier&gt;</a></td><td class="col-quantity">3</td><td class="col-amount">${formatCurrency(1250)}</td><td class="col-quantity">7</td></tr>`,
    );
    expect(html).toContain(
      `<tr><td><a href="/admin/listing/42">Free tier</a></td><td class="col-quantity">12</td><td class="col-amount">${formatCurrency(0)}</td><td class="col-quantity">0</td></tr>`,
    );
    expect(html).not.toContain("No renewal tier listing is configured.");
  });
});
