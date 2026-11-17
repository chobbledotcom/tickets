import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { adminBrowser, ORGANISER } from "#test/specs/support/browser.ts";
import { managerBrowser } from "#test/specs/support/staff-accounts.ts";
import {
  SUBSCRIPTIONS_PAGE,
  stripeCancelsWhenAsked,
  subscriberOn,
  subscriberRow,
} from "#test/specs/support/subscriptions.ts";
import {
  keepWhatTheyWereTold,
  requiredWorldValue,
  type TicketsWorld,
  whatTheyWereTold,
} from "#test/specs/support/world.ts";

const CANCEL_BUTTON = "Cancel subscription";

const customerName = (world: TicketsWorld): string =>
  requiredWorldValue(world.attendeeName, "the customer's name");

Given(
  "Stripe ends a subscription when the site asks",
  function (this: TicketsWorld): void {
    stripeCancelsWhenAsked(this);
  },
);

When(
  "the owner cancels the customer's subscription",
  async function (this: TicketsWorld): Promise<void> {
    const browser = await adminBrowser(this);
    await browser.visit(SUBSCRIPTIONS_PAGE);
    await browser.submitForm({}, CANCEL_BUTTON);
    keepWhatTheyWereTold(this, ORGANISER, browser.currentHtml);
  },
);

Then(
  "the customer's subscription offers no cancel",
  function (this: TicketsWorld): void {
    expect(
      subscriberRow(whatTheyWereTold(this, ORGANISER), customerName(this)),
    ).not.toContain(CANCEL_BUTTON);
  },
);

Then(
  "the {word} booking is still there",
  async function (this: TicketsWorld, name: string): Promise<void> {
    const browser = await adminBrowser(this);
    expect(
      await browser.visit(`/admin/attendees/${await subscriberOn(this, name)}`),
    ).toBe(200);
    expect(browser.pageText).toContain(customerName(this));
  },
);

When(
  "the owner opens the delete page of the customer",
  async function (this: TicketsWorld): Promise<void> {
    const browser = await adminBrowser(this);
    const attendeeId = await subscriberOn(this, "Club");
    await browser.visit(`/admin/attendees/${attendeeId}/delete`);
    keepWhatTheyWereTold(this, ORGANISER, browser.currentHtml);
  },
);

When(
  "{word} opens the Subscriptions page",
  async function (this: TicketsWorld, who: string): Promise<void> {
    const browser = managerBrowser(this, who);
    expect(await browser.visit(SUBSCRIPTIONS_PAGE)).toBe(200);
    keepWhatTheyWereTold(this, who, browser.currentHtml);
  },
);

Then(
  "{word} sees the customer but no way to cancel",
  function (this: TicketsWorld, who: string): void {
    const page = whatTheyWereTold(this, who);
    expect(subscriberRow(page, customerName(this))).not.toContain(
      CANCEL_BUTTON,
    );
    expect(page).not.toContain("/cancel");
  },
);
