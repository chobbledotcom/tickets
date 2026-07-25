import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  balanceInvalidPage,
  balanceNoItemsPage,
  balancePaymentPage,
  balanceSettledPage,
} from "#templates/public/balance.tsx";
import { registerPublicTemplateHooks } from "#test/templates/public/helpers.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";

describe("public balance templates", () => {
  beforeAll(setupAdminPageTest);
  registerPublicTemplateHooks();

  test("renders the order recap and payment action", () => {
    const html = balancePaymentPage("balance-token", 1250, {
      depositPaid: 500,
      fullPrice: 1750,
      lines: [
        { listingId: 1, name: "First item", quantity: 2 },
        { listingId: 2, name: "Second item", quantity: 1 },
      ],
      reservationSubtotal: 500,
      totalQuantity: 3,
    });

    expect(html).toContain("<h1>Pay your balance</h1>");
    expect(html).toContain("Here's a summary of your booking.");
    expect(html).toContain("First item");
    expect(html).toContain("Second item");
    expect(html).toContain("Full order price:");
    expect(html).toContain("Already paid:");
    expect(html).toContain("Balance due:");
    expect(html).toContain("£17.50");
    expect(html).toContain("£5");
    expect(html).toContain("£12.50");
    expect(html).toContain('action="/pay/balance-token"');
    expect(html).toContain("Pay £12.50 now");
  });

  test("renders the settled state", () => {
    const html = balanceSettledPage();

    expect(html).toContain("<title>Nothing to pay</title>");
    expect(html).toContain("This booking has no outstanding balance.");
  });

  test("renders the invalid-link state", () => {
    const html = balanceInvalidPage();

    expect(html).toContain("<title>Link not valid</title>");
    expect(html).toContain("This payment link is not valid");
    expect(html).toContain("expired or been mistyped");
  });

  test("renders the no-items state", () => {
    const html = balanceNoItemsPage();

    expect(html).toContain("<title>No tickets to pay for</title>");
    expect(html).toContain("This booking has no tickets to pay for");
    expect(html).toContain("This reservation has no bookable tickets");
  });
});
