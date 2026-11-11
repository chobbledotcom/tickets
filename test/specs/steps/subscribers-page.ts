import { Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { adminBrowser, ORGANISER } from "#test/specs/support/browser.ts";
import { editorBrowser } from "#test/specs/support/editors.ts";
import {
  menuOffersSubscriptions,
  SUBSCRIPTIONS_PAGE,
  subscriberRow,
} from "#test/specs/support/subscriptions.ts";
import {
  keepWhatTheyWereTold,
  requiredWorldValue,
  type TicketsWorld,
  whatTheyWereTold,
} from "#test/specs/support/world.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";

/** The customer's row on the Subscriptions page the owner last opened. */
const customerRow = (world: TicketsWorld): string =>
  subscriberRow(
    whatTheyWereTold(world, ORGANISER),
    requiredWorldValue(world.attendeeName, "the customer's name"),
  );

When(
  "the owner opens Subscriptions from the menu",
  async function (this: TicketsWorld): Promise<void> {
    const browser = await adminBrowser(this);
    expect(menuOffersSubscriptions(browser.currentHtml)).toBe(true);
    await browser.visit(SUBSCRIPTIONS_PAGE);
    keepWhatTheyWereTold(this, ORGANISER, browser.currentHtml);
  },
);

When(
  "the owner looks at the menu",
  async function (this: TicketsWorld): Promise<void> {
    const browser = await adminBrowser(this);
    keepWhatTheyWereTold(this, ORGANISER, browser.currentHtml);
  },
);

Then("the menu offers no Subscriptions", function (this: TicketsWorld): void {
  expect(menuOffersSubscriptions(whatTheyWereTold(this, ORGANISER))).toBe(
    false,
  );
});

Then(
  "the Subscriptions page lists the customer on the {word} ticket",
  function (this: TicketsWorld, ticket: string): void {
    expect(customerRow(this)).toContain(`<td>${ticket}</td>`);
  },
);

Then(
  "the customer's subscription charges {string} with {string} of tax",
  function (this: TicketsWorld, charge: string, tax: string): void {
    expectIncludesAll(customerRow(this), [
      `<td>${charge}</td>`,
      `<td>${tax}</td>`,
    ]);
  },
);

Then(
  "the customer's subscription reads {string}",
  function (this: TicketsWorld, status: string): void {
    expect(customerRow(this)).toContain(`<td>${status}</td>`);
  },
);

Then(
  "{word} sees no Subscriptions in the menu and cannot open the page",
  async function (this: TicketsWorld, _who: string): Promise<void> {
    const browser = editorBrowser(this);
    await browser.visit("/admin/");
    expect(menuOffersSubscriptions(browser.currentHtml)).toBe(false);
    expect(await browser.visit(SUBSCRIPTIONS_PAGE)).toBe(403);
  },
);
