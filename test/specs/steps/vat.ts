// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { attendeeAccount, TAX_VAT, WORLD } from "#accounting/accounts.ts";
import { accountBalance, transfersByAccount } from "#accounting/queries.ts";
import { settings } from "#db/settings.ts";
import { sumOf } from "#fp";
import { assessTax } from "#shared/tax/assessment.ts";
import type { TaxPolicy } from "#shared/tax/types.ts";
import {
  adminBrowser,
  scenarioBrowser,
  submitRenderedAdminForm,
} from "#test/specs/support/browser.ts";
import { emailFor } from "#test/specs/support/emails.ts";
import { listingIdNamed } from "#test/specs/support/listings.ts";
import {
  minorUnits,
  sellPlacesAt,
  timesProviderWasAsked,
} from "#test/specs/support/money.ts";
import { runStripeSuccess } from "#test/specs/support/money-drivers.ts";
import {
  attendeeLegsOfKind,
  incomeOf,
  legsOfKind,
  owedBy,
  sumOfAllBalances,
  worldBalance,
} from "#test/specs/support/money-reads.ts";
import { type TicketsWorld, theBooking } from "#test/specs/support/world.ts";
import { hasCheckedInput, inputTagWithValue } from "#test-utils/csrf.ts";
import { openAttendeeEditor } from "#test-utils/e2e.ts";
import { setupStripe } from "#test-utils/settings.ts";

// jscpd:ignore-end

/** A rate typed as "20" or "17.51" into the site's tax-rate box, in basis
 *  points the same way the site's own form parser reads it. */
const rateToBasisPoints = (rate: string): number => {
  const value = Number(rate);
  assert(
    Number.isFinite(value) && value >= 0,
    `A tax rate must be a non-negative number, got ${rate}`,
  );
  return Math.round(value * 100);
};

const taxPolicy = (
  mode: "add_to_total" | "calculate_from_total",
  rate: string,
): TaxPolicy => ({ mode, rateBasisPoints: rateToBasisPoints(rate) });

/** Sell one place and pay its tax-inclusive total, the way a checkout taken
 *  under the current Tax setting freezes it: the rate the site now shows is
 *  what the sale is priced with, and what the customer is charged. */
const payForOnePlace = async (
  world: TicketsWorld,
  name: string,
  pounds: string,
  who: string,
): Promise<number> => {
  await setupStripe();
  const { id: listingId } = await sellPlacesAt(world, name, pounds);
  const gross = minorUnits(pounds);
  const policy = settings.tax;
  const total = assessTax(
    { lines: [{ gross, listingId }], modifiers: [] },
    policy,
  ).total;
  const attendeeId = await runStripeSuccess(world, {
    email: emailFor(who),
    items: JSON.stringify([{ e: listingId, p: gross, q: 1 }]),
    name: who,
    paymentIntent: `pi_${name.toLowerCase().replaceAll(" ", "_")}`,
    sessionId: `cs_${name.toLowerCase().replaceAll(" ", "_")}`,
    taxPolicy: policy,
    total,
  });
  world.attendeeId = attendeeId;
  world.attendeeName = who;
  return attendeeId;
};

// -- Tax settings ---------------------------------------------------------- //

Given(
  "the site adds {int} percent value added tax to listed prices",
  async function (this: TicketsWorld, rate: number): Promise<void> {
    await settings.update.tax(taxPolicy("add_to_total", String(rate)));
  },
);

Given(
  "the site adds value added tax at {word} percent to listed prices",
  async function (this: TicketsWorld, rate: string): Promise<void> {
    await settings.update.tax(taxPolicy("add_to_total", rate));
  },
);

Given(
  "listed prices include {int} percent value added tax",
  async function (this: TicketsWorld, rate: number): Promise<void> {
    await settings.update.tax(taxPolicy("calculate_from_total", String(rate)));
  },
);

Given(
  "listed prices include value added tax at {word} percent",
  async function (this: TicketsWorld, rate: string): Promise<void> {
    await settings.update.tax(taxPolicy("calculate_from_total", rate));
  },
);

When(
  "the organiser sets {word} percent value added tax added to listed prices",
  function (this: TicketsWorld, rate: string): Promise<unknown> {
    return submitRenderedAdminForm(this, "/admin/settings", "Save Tax", {
      tax_mode: "add_to_total",
      tax_rate: rate,
    });
  },
);

When(
  "the organiser sets {word} percent value added tax included in listed prices",
  function (this: TicketsWorld, rate: string): Promise<unknown> {
    return submitRenderedAdminForm(this, "/admin/settings", "Save Tax", {
      tax_mode: "calculate_from_total",
      tax_rate: rate,
    });
  },
);

When(
  "the organiser sets a tax rate the site cannot store",
  function (this: TicketsWorld): Promise<unknown> {
    return submitRenderedAdminForm(this, "/admin/settings", "Save Tax", {
      tax_mode: "add_to_total",
      // The rate box accepts any whole-number digits; the site itself refuses
      // a rate too large to store as a whole number of basis points.
      tax_rate: "99999999999999999999",
    });
  },
);

Then(
  "the tax settings show added value added tax at {word} percent",
  function (this: TicketsWorld, rate: string): void {
    const browser = scenarioBrowser(this);
    expect(
      hasCheckedInput(browser.currentHtml, "tax_mode", "add_to_total"),
    ).toBe(true);
    expect(
      inputTagWithValue(
        browser.currentHtml,
        Number(rate).toFixed(2),
        "tax_rate",
      ),
    ).not.toBe("");
  },
);

Then(
  "the tax settings show included value added tax at {word} percent",
  function (this: TicketsWorld, rate: string): void {
    const browser = scenarioBrowser(this);
    expect(
      hasCheckedInput(browser.currentHtml, "tax_mode", "calculate_from_total"),
    ).toBe(true);
    expect(
      inputTagWithValue(
        browser.currentHtml,
        Number(rate).toFixed(2),
        "tax_rate",
      ),
    ).not.toBe("");
  },
);

Then(
  "the organiser is told the tax rate is not accepted",
  function (this: TicketsWorld): void {
    const browser = scenarioBrowser(this);
    assertStringIncludes(
      browser.pageText,
      "Enter a non-negative tax rate with at most two decimal places.",
    );
  },
);

Then("the site still collects no tax", function (this: TicketsWorld): void {
  expect(settings.tax).toEqual({ mode: "none" });
  const browser = scenarioBrowser(this);
  expect(hasCheckedInput(browser.currentHtml, "tax_mode", "none")).toBe(true);
});

// -- Buying and refunding under a tax setting ------------------------------ //

When(
  "a customer pays for a {word} place listed at {word}",
  function (this: TicketsWorld, name: string, price: string): Promise<number> {
    return payForOnePlace(this, name, price, `${name} Buyer`);
  },
);

Given(
  "a customer paid {word} for a {word} place with value added tax",
  async function (
    this: TicketsWorld,
    price: string,
    name: string,
  ): Promise<void> {
    await payForOnePlace(this, name, price, `${name} Buyer`);
    // The sale happened; how the income split lands depends on the tax mode,
    // which the story's own Then steps assert.
    const legs = await transfersByAccount(attendeeAccount(theBooking(this)));
    expect(legsOfKind(legs, "sale").length).toBe(1);
  },
);

Then(
  "the {word} place has earned {word} and the VAT account holds {word}",
  async function (
    this: TicketsWorld,
    name: string,
    earned: string,
    vat: string,
  ): Promise<void> {
    expect(await incomeOf(listingIdNamed(this, name))).toBe(minorUnits(earned));
    expect(await accountBalance(TAX_VAT)).toBe(minorUnits(vat));
  },
);

Then(
  "the {word} place has earned {word}",
  async function (
    this: TicketsWorld,
    name: string,
    earned: string,
  ): Promise<void> {
    expect(await incomeOf(listingIdNamed(this, name))).toBe(minorUnits(earned));
  },
);

Then(
  "the {word} place and the VAT account both hold nothing",
  async function (this: TicketsWorld, name: string): Promise<void> {
    expect(await incomeOf(listingIdNamed(this, name))).toBe(0);
    expect(await accountBalance(TAX_VAT)).toBe(0);
  },
);

/** The tax account's balance alone could hide a tax leg that a refund later
 *  reversed, so the booking's own legs are checked for both tax kinds too. */
Then(
  "no VAT was recorded or refunded",
  async function (this: TicketsWorld): Promise<void> {
    expect(await accountBalance(TAX_VAT)).toBe(0);
    const legs = await transfersByAccount(attendeeAccount(theBooking(this)));
    expect(legsOfKind(legs, "vat").length).toBe(0);
    expect(legsOfKind(legs, "refund_vat").length).toBe(0);
  },
);

Then(
  "the customer is given back {word} once",
  async function (this: TicketsWorld, amount: string): Promise<void> {
    expect(timesProviderWasAsked(this)).toBe(1);
    const handedBack = await attendeeLegsOfKind(
      theBooking(this),
      "refund_cash",
    );
    expect(handedBack.length).toBe(1);
    expect(handedBack[0]!.amount).toBe(minorUnits(amount));
    expect(handedBack[0]!.destination).toEqual(WORLD);
  },
);

// -- Applying the current tax setting to an existing booking -------------- //

When(
  "the organiser saves the {word} booking",
  async function (this: TicketsWorld, name: string): Promise<void> {
    const browser = await adminBrowser(this);
    await browser.visit(
      `/admin/listing/${listingIdNamed(this, name)}/attendees`,
    );
    await openAttendeeEditor(browser);
    await browser.submitForm({}, "Save Attendee");
  },
);

Then(
  "the booking now carries {word} of value added tax and the customer owes {word}",
  async function (
    this: TicketsWorld,
    vat: string,
    owes: string,
  ): Promise<void> {
    expect(await accountBalance(TAX_VAT)).toBe(minorUnits(vat));
    expect(await owedBy(theBooking(this))).toBe(minorUnits(owes));
  },
);

Then(
  "the organiser is told the tax change was applied",
  function (this: TicketsWorld): void {
    const browser = scenarioBrowser(this);
    assertStringIncludes(
      browser.currentHtml,
      "We applied your current Tax settings",
    );
  },
);

Then(
  "no money was taken or returned",
  async function (this: TicketsWorld): Promise<void> {
    const legs = await transfersByAccount(attendeeAccount(theBooking(this)));
    const paid = sumOf((leg: { amount: number }) => leg.amount)(
      legsOfKind(legs, "payment"),
    );
    // The site still holds exactly the price the customer paid: a tax save
    // moves the books, never the cash.
    expect(await worldBalance()).toBe(-paid);
    expect(await sumOfAllBalances()).toBe(0);
  },
);
