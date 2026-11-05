import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  balanceInvalidPage,
  balanceNoItemsPage,
  balancePaymentPage,
  balanceSettledPage,
} from "#templates/public/balance.tsx";
import { registerPublicTemplateHooks } from "#test/ui/templates/helpers.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";

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

    expectIncludesAll(html, [
      "<h1>Pay your balance</h1>",
      "Here's a summary of your booking.",
      "First item",
      "Second item",
      "Full order price:",
      "Already paid:",
      "Balance due:",
      "£17.50",
      "£5",
      "£12.50",
      'action="/pay/balance-token"',
      "Pay £12.50 now",
    ]);
  });

  test("renders the settled state", () => {
    const html = balanceSettledPage();

    expectIncludesAll(html, [
      "<title>Nothing to pay</title>",
      "This booking has no outstanding balance.",
    ]);
  });

  test("renders the invalid-link state", () => {
    const html = balanceInvalidPage();

    expectIncludesAll(html, [
      "<title>Link not valid</title>",
      "This payment link is not valid",
      "expired or been mistyped",
    ]);
  });

  test("renders the no-items state", () => {
    const html = balanceNoItemsPage();

    expectIncludesAll(html, [
      "<title>No tickets to pay for</title>",
      "This booking has no tickets to pay for",
      "This reservation has no bookable tickets",
    ]);
  });
});
