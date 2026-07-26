// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import {
  attendeeAccount,
  BOOKING_FEE_INCOME,
  modifierAccount,
  revenueAccount,
  WRITEOFF,
} from "#shared/accounting/accounts.ts";
import {
  accountBalance,
  transfersByAccount,
} from "#shared/accounting/queries.ts";
import {
  addBalanceEntry,
  cashBefore,
  correctOnPage,
  rememberMoneyBefore,
  surchargeEarning,
  surchargeId,
} from "#test/specs/support/corrections.ts";
import {
  payDeposit,
  settleTheRest,
  unpaidPlace,
} from "#test/specs/support/deposits.ts";
import {
  bookingId,
  expectMoneyHandedBack,
  listingIdFor,
  minorUnits,
} from "#test/specs/support/money.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import {
  adminPageHtml,
  assertEditPageIncome,
  assertRenderedIncome,
  assertRenderedModifierRevenue,
  assertRenderedOwed,
  assertStatementBalance,
  incomeOf,
  kindsOf,
  legsOfKind,
  modifierRevenueOf,
  owedBy,
  worldBalance,
} from "#test-utils/money/reads.ts";

// jscpd:ignore-end

const GOODWILL = "manual_attendee_writeoff";
const CHARGE = "manual_attendee_charge";

Then(
  "the booking holds one sale and one payment of {word}, in one order",
  async function (this: TicketsWorld, amount: string): Promise<void> {
    const legs = await transfersByAccount(attendeeAccount(bookingId(this)));
    expect(kindsOf(legs)).toEqual(["payment", "sale"]);
    // Both belong to the same order, so nothing was recorded twice.
    expect(new Set(legs.map((leg) => leg.eventGroup)).size).toBe(1);
    expect(legsOfKind(legs, "sale")[0]!.amount).toBe(minorUnits(amount));
    expect(legsOfKind(legs, "payment")[0]!.amount).toBe(minorUnits(amount));
  },
);

Then("no booking fee was taken", async (): Promise<void> => {
  expect(await accountBalance(BOOKING_FEE_INCOME)).toBe(0);
});

Then(
  "every page shows the {word} earning {word}",
  async function (
    this: TicketsWorld,
    listing: string,
    amount: string,
  ): Promise<void> {
    await assertRenderedIncome(listingIdFor(this, listing), minorUnits(amount));
  },
);

When(
  "the organiser corrects the {word} listing's income to {word}",
  async function (
    this: TicketsWorld,
    listing: string,
    amount: string,
  ): Promise<void> {
    await rememberMoneyBefore(this);
    await correctOnPage(
      this,
      `/admin/listing/${listingIdFor(this, listing)}/edit`,
      "income",
      amount,
      "Listing income corrected.",
    );
  },
);

Then(
  "the {word} listing has earned {word}",
  async function (
    this: TicketsWorld,
    listing: string,
    amount: string,
  ): Promise<void> {
    expect(await incomeOf(listingIdFor(this, listing))).toBe(
      minorUnits(amount),
    );
  },
);

Then(
  "the {word} difference was written off in one correction",
  async function (this: TicketsWorld, amount: string): Promise<void> {
    const listingId = requiredWorldValue(this.listingId, "the listing");
    const corrections = legsOfKind(
      await transfersByAccount(revenueAccount(listingId)),
      "adjustment",
    );
    expect(corrections.length).toBe(1);
    expect(corrections[0]!.amount).toBe(minorUnits(amount));
    // Written down means out of the listing's earnings and into the write-off.
    expect(corrections[0]!.source).toEqual(revenueAccount(listingId));
    expect(corrections[0]!.destination).toEqual(WRITEOFF);
  },
);

Then(
  "the money the site holds is unchanged",
  async function (this: TicketsWorld): Promise<void> {
    expect(await worldBalance()).toBe(cashBefore(this));
  },
);

Given(
  "a customer owes {word} for a {word} place",
  async function (
    this: TicketsWorld,
    amount: string,
    listing: string,
  ): Promise<void> {
    await unpaidPlace(this, listing, amount);
    expect(await owedBy(bookingId(this))).toBe(minorUnits(amount));
  },
);

When(
  "the organiser lets them off {word}",
  async function (this: TicketsWorld, amount: string): Promise<void> {
    await rememberMoneyBefore(this);
    await addBalanceEntry(this, bookingId(this), GOODWILL, amount);
  },
);

When(
  "the organiser charges them {word} more",
  function (this: TicketsWorld, amount: string): Promise<void> {
    return addBalanceEntry(this, bookingId(this), CHARGE, amount);
  },
);

Then(
  "they owe {word}, on the books and on their money page",
  async function (this: TicketsWorld, amount: string): Promise<void> {
    expect(await owedBy(bookingId(this))).toBe(minorUnits(amount));
    await assertRenderedOwed(bookingId(this), minorUnits(amount));
  },
);

Then(
  "the {word} has still earned {word}, and the money the site holds is unchanged",
  async function (
    this: TicketsWorld,
    listing: string,
    amount: string,
  ): Promise<void> {
    // A correction to what someone owes touches neither the listing's earnings
    // nor the cash the site holds.
    expect(await incomeOf(listingIdFor(this, listing))).toBe(
      minorUnits(amount),
    );
    expect(await worldBalance()).toBe(cashBefore(this));
  },
);

Given(
  "a {word} {word} that has earned {word}",
  async function (
    this: TicketsWorld,
    first: string,
    second: string,
    earned: string,
  ): Promise<void> {
    await surchargeEarning(this, `${first} ${second}`, earned);
    expect(await modifierRevenueOf(surchargeId(this))).toBe(minorUnits(earned));
  },
);

When(
  "the organiser corrects the surcharge's income to {word}",
  async function (this: TicketsWorld, amount: string): Promise<void> {
    await rememberMoneyBefore(this);
    await correctOnPage(
      this,
      `/admin/modifiers/${surchargeId(this)}/edit`,
      "total_revenue",
      amount,
      "Option income corrected.",
    );
  },
);

Then(
  "the surcharge's earnings are now {word}",
  async function (this: TicketsWorld, amount: string): Promise<void> {
    expect(await modifierRevenueOf(surchargeId(this))).toBe(minorUnits(amount));
  },
);

Then(
  "the {word} difference came from the write-off in one correction",
  async function (this: TicketsWorld, amount: string): Promise<void> {
    const corrections = legsOfKind(
      await transfersByAccount(modifierAccount(surchargeId(this))),
      "adjustment",
    );
    expect(corrections.length).toBe(1);
    expect(corrections[0]!.amount).toBe(minorUnits(amount));
    // Raising what it earned takes the difference out of the write-off.
    expect(corrections[0]!.source).toEqual(WRITEOFF);
    expect(corrections[0]!.destination).toEqual(
      modifierAccount(surchargeId(this)),
    );
  },
);

Then(
  "every page shows the surcharge's earnings as {word}",
  async function (this: TicketsWorld, amount: string): Promise<void> {
    await assertRenderedModifierRevenue(surchargeId(this), minorUnits(amount));
  },
);

When(
  "they pay a deposit of {word}",
  function (this: TicketsWorld, amount: string): Promise<void> {
    return payDeposit(this, amount);
  },
);

When(
  "the organiser settles the remaining {word}",
  function (this: TicketsWorld, amount: string): Promise<void> {
    return settleTheRest(this, amount);
  },
);

Then(
  "they still owe {word}, on the books and on their money page",
  async function (this: TicketsWorld, amount: string): Promise<void> {
    expect(await owedBy(bookingId(this))).toBe(minorUnits(amount));
    await assertRenderedOwed(bookingId(this), minorUnits(amount));
  },
);

Then(
  "they owe nothing, and their money page says the booking is fully paid",
  async function (this: TicketsWorld): Promise<void> {
    expect(await owedBy(bookingId(this))).toBe(0);
    const page = await adminPageHtml(
      `/admin/attendees/${bookingId(this)}/ledger`,
    );
    expect(page).toContain("This booking is fully paid");
  },
);

Then(
  "the {word} earned {word} and the customer owes nothing",
  async function (
    this: TicketsWorld,
    listing: string,
    amount: string,
  ): Promise<void> {
    expect(await incomeOf(listingIdFor(this, listing))).toBe(
      minorUnits(amount),
    );
    expect(await owedBy(bookingId(this))).toBe(0);
  },
);

Given(
  "the organiser corrected the {word} listing's income to {word}",
  async function (
    this: TicketsWorld,
    listing: string,
    amount: string,
  ): Promise<void> {
    await rememberMoneyBefore(this);
    await correctOnPage(
      this,
      `/admin/listing/${listingIdFor(this, listing)}/edit`,
      "income",
      amount,
      "Listing income corrected.",
    );
  },
);

Then(
  "the customer has the whole {word} back and owes nothing",
  async function (this: TicketsWorld, amount: string): Promise<void> {
    await expectMoneyHandedBack(this, minorUnits(amount));
    expect(await owedBy(bookingId(this))).toBe(0);
  },
);

Then(
  "the money record shows the write-off still standing at {word}",
  async function (this: TicketsWorld, amount: string): Promise<void> {
    // The refund gave back what was paid; it did not undo the correction, so
    // the listing's own record is left showing the write-off.
    await assertStatementBalance(
      requiredWorldValue(this.listingId, "the listing"),
      minorUnits(amount),
    );
  },
);

Then(
  "the listing page still shows {word} earned",
  async function (this: TicketsWorld, amount: string): Promise<void> {
    // The listing page counts what was earned less write-offs, and knows
    // nothing of refunds — so it keeps its own, different figure.
    await assertEditPageIncome(
      requiredWorldValue(this.listingId, "the listing"),
      minorUnits(amount),
    );
  },
);
