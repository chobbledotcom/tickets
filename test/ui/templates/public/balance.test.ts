import { assertStringIncludes } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  balanceInvalidPage,
  balanceNoItemsPage,
  balancePaymentPage,
  balanceSettledPage,
} from "#templates/public/balance.tsx";
import { registerPublicTemplateHooks } from "#test/ui/templates/helpers.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";

describe("public balance templates", () => {
  beforeAll(setupAdminPageTest);
  registerPublicTemplateHooks();

  test("renders the order recap and payment action", () => {
    const html = balancePaymentPage("balance-token", 1250, {
      depositPaid: 500,
      fullPrice: 1750,
      lines: [
        { name: "First item", quantity: 2 },
        { name: "Second item", quantity: 1 },
      ],
    });

    assertStringIncludes(html, "<h1>Pay your balance</h1>");
    assertStringIncludes(html, "Here's a summary of your booking.");
    assertStringIncludes(html, "First item");
    assertStringIncludes(html, "Second item");
    assertStringIncludes(html, "Full order price:");
    assertStringIncludes(html, "Already paid:");
    assertStringIncludes(html, "Balance due:");
    assertStringIncludes(html, "£17.50");
    assertStringIncludes(html, "£5");
    assertStringIncludes(html, "£12.50");
    assertStringIncludes(html, 'action="/pay/balance-token"');
    assertStringIncludes(html, "Pay £12.50 now");
  });

  test("renders the settled state", () => {
    const html = balanceSettledPage();

    assertStringIncludes(html, "<title>Nothing to pay</title>");
    assertStringIncludes(html, "This booking has no outstanding balance.");
  });

  test("renders the invalid-link state", () => {
    const html = balanceInvalidPage();

    assertStringIncludes(html, "<title>Link not valid</title>");
    assertStringIncludes(html, "This payment link is not valid");
    assertStringIncludes(html, "expired or been mistyped");
  });

  test("renders the no-items state", () => {
    const html = balanceNoItemsPage();

    assertStringIncludes(html, "<title>No tickets to pay for</title>");
    assertStringIncludes(html, "This booking has no tickets to pay for");
    assertStringIncludes(html, "This reservation has no bookable tickets");
  });
});
