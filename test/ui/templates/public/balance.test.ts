import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  balanceInvalidPage,
  balanceNoItemsPage,
  balancePaymentPage,
  balanceSettledPage,
} from "#templates/public/balance.tsx";
import { registerPublicTemplateHooks } from "#test/ui/templates/helpers.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { says } from "#test-utils/says.ts";

describe("public balance templates", () => {
  beforeAll(setupAdminPageTest);
  registerPublicTemplateHooks();

  test("renders the order recap and payment action", () => {
    const html = balancePaymentPage("balance-token", 1250, {
      depositPaid: 500,
      fullPrice: 1750,
      lines: [
        { listingId: 1, name: "First item", packageGroupId: 0, quantity: 2 },
        { listingId: 2, name: "Second item", packageGroupId: 0, quantity: 1 },
      ],
      reservationSubtotal: 500,
      totalQuantity: 3,
    });

    says(html, "<h1>Pay your balance</h1>");
    says(html, "Here's a summary of your booking.");
    says(html, "First item");
    says(html, "Second item");
    says(html, "Full order price:");
    says(html, "Already paid:");
    says(html, "Balance due:");
    says(html, "£17.50");
    says(html, "£5");
    says(html, "£12.50");
    says(html, 'action="/pay/balance-token"');
    says(html, "Pay £12.50 now");
  });

  test("renders the settled state", () => {
    const html = balanceSettledPage();

    says(html, "<title>Nothing to pay</title>");
    says(html, "This booking has no outstanding balance.");
  });

  test("renders the invalid-link state", () => {
    const html = balanceInvalidPage();

    says(html, "<title>Link not valid</title>");
    says(html, "This payment link is not valid");
    says(html, "expired or been mistyped");
  });

  test("renders the no-items state", () => {
    const html = balanceNoItemsPage();

    says(html, "<title>No tickets to pay for</title>");
    says(html, "This booking has no tickets to pay for");
    says(html, "This reservation has no bookable tickets");
  });
});
