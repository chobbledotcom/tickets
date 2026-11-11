import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import { requireValue } from "#shared/required-value.ts";
import { firstRecurringChargeAt } from "#shared/subscriptions/plan.ts";
import {
  CUSTOMER,
  ORGANISER,
  openAdminPage,
} from "#test/specs/support/browser.ts";
import {
  organiserSavesFields,
  putsPlainThingOnSale,
} from "#test/specs/support/listings.ts";
import { minorUnits } from "#test/specs/support/money.ts";
import {
  chargedAgain,
  chargedNow,
  customerSubscribes,
  plansOnBookings,
} from "#test/specs/support/subscriptions.ts";
import {
  keepWhatTheyWereTold,
  type TicketsWorld,
  whatTheyWereTold,
} from "#test/specs/support/world.ts";
import { setupStripe } from "#test-utils/settings.ts";

type Interval = "week" | "month" | "year";

Given(
  "Stripe takes payments for the site",
  async function (this: TicketsWorld): Promise<void> {
    await setupStripe();
  },
);

Given(
  "Square takes payments for the site",
  async function (this: TicketsWorld): Promise<void> {
    await settings.update.paymentProvider("square");
  },
);

Given(
  "the organiser sells a {word} ticket at {word} that charges {word} again every {word}",
  async function (
    this: TicketsWorld,
    name: string,
    price: string,
    recurringPrice: string,
    interval: Interval,
  ): Promise<void> {
    await putsPlainThingOnSale(this, name, { unitPrice: minorUnits(price) });
    await organiserSavesFields(this, name, {
      recurring_interval: interval,
      recurring_price: recurringPrice,
    });
  },
);

// Registered once, so a story reaches it under Given or When.
When(
  /^a customer subscribes with (\d+) (\w+) tickets?$/,
  function (this: TicketsWorld, places: string, name: string): Promise<void> {
    return customerSubscribes(this, name, Number(places));
  },
);

When(
  "the organiser changes the {word} recurring price to {word}",
  function (this: TicketsWorld, name: string, price: string): Promise<void> {
    return organiserSavesFields(this, name, { recurring_price: price });
  },
);

When(
  "the organiser opens the form for a new listing",
  async function (this: TicketsWorld): Promise<void> {
    const browser = await openAdminPage(
      this,
      "/admin/listing/new?template=custom",
    );
    keepWhatTheyWereTold(this, ORGANISER, browser.currentHtml);
  },
);

Then(
  "Stripe is asked to charge {word} now and {word} every {word} from one {word} later",
  function (
    this: TicketsWorld,
    now: string,
    again: string,
    interval: Interval,
    period: Interval,
  ): void {
    expect(period).toBe(interval);
    const { asked, sentAfter, sentBefore } = this.things.require(
      "checkout",
      CUSTOMER,
    );
    expect(asked.mode).toBe("subscription");
    expect(chargedNow(asked)).toBe(minorUnits(now));
    expect(chargedAgain(asked)).toEqual([
      { interval, quantity: 1, unitAmount: minorUnits(again) },
    ]);
    // The clock moves while the site builds the checkout, so the first
    // recurring charge lies one period after some moment in that window.
    const { trial_end: trialEnd } = requireValue(
      asked.subscription_data,
      "A subscription checkout sent no subscription data",
    );
    expect(trialEnd).toBeGreaterThanOrEqual(
      firstRecurringChargeAt(sentBefore, period),
    );
    expect(trialEnd).toBeLessThanOrEqual(
      firstRecurringChargeAt(sentAfter, period),
    );
  },
);

Then(
  "the {word} booking pays {word} every {word} with {word} of tax",
  async function (
    this: TicketsWorld,
    name: string,
    price: string,
    interval: Interval,
    tax: string,
  ): Promise<void> {
    expect(await plansOnBookings(this, name)).toEqual([
      {
        recurring_interval: interval,
        recurring_price: minorUnits(price),
        recurring_tax: minorUnits(tax),
        subscription_id: "sub_story",
      },
    ]);
  },
);

Then("the form offers no recurring price", function (this: TicketsWorld): void {
  const form = whatTheyWereTold(this, ORGANISER);
  expect(form).toContain('name="name"');
  expect(form).not.toContain(t("fields.listing.recurring_price"));
  expect(form).not.toContain('name="recurring_price"');
  expect(form).not.toContain('name="recurring_interval"');
});
