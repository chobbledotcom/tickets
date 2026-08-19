// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import {
  attendeeAccount,
  BOOKING_FEE_INCOME,
  modifierAccount,
  revenueAccount,
  WRITEOFF,
} from "#accounting/accounts.ts";
import { accountBalance, transfersByAccount } from "#accounting/queries.ts";
import { formatCurrency } from "#shared/currency.ts";
import {
  addBalanceEntry,
  cashBefore,
  correctOnPage,
  rememberMoneyBefore,
  surchargeEarning,
  surchargeId,
} from "#test/specs/support/corrections.ts";
import {
  balancePageHtml,
  payDeposit,
  settleTheRest,
  unpaidPlace,
} from "#test/specs/support/deposits.ts";
import { listingIdNamed } from "#test/specs/support/listings.ts";
import {
  bookingId,
  expectMoneyHandedBack,
  minorUnits,
} from "#test/specs/support/money.ts";
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
} from "#test/specs/support/money-reads.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";

// jscpd:ignore-end

const LISTING_TOLD = "Listing income corrected.";
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
    await assertRenderedIncome(
      listingIdNamed(this, listing),
      minorUnits(amount),
    );
  },
);

/** One thing's earnings, corrected on the page that offers the box — the same
 * act for a listing and for an extra charge, so it is written once. */
const correctEarnings = async (
  world: TicketsWorld,
  page: string,
  field: string,
  amount: string,
  told: string,
): Promise<void> => {
  await rememberMoneyBefore(world);
  await correctOnPage(world, page, field, amount, told);
};

/** Correcting a listing's income, from both the Given and the When wording. */
const correctListingIncome = function (
  this: TicketsWorld,
  listing: string,
  amount: string,
): Promise<void> {
  const page = `/admin/listing/${listingIdNamed(this, listing)}/edit`;
  return correctEarnings(this, page, "income", amount, LISTING_TOLD);
};

When(
  "the organiser corrects the {word} listing's income to {word}",
  correctListingIncome,
);

Then(
  "the {word} listing has earned {word}",
  async function (
    this: TicketsWorld,
    listing: string,
    amount: string,
  ): Promise<void> {
    expect(await incomeOf(listingIdNamed(this, listing))).toBe(
      minorUnits(amount),
    );
  },
);

/** Exactly one correction moved exactly this much, this way round. */
const expectOneCorrection = async (
  account: ReturnType<typeof revenueAccount>,
  amount: string,
  from: ReturnType<typeof revenueAccount>,
  to: ReturnType<typeof revenueAccount>,
): Promise<void> => {
  const corrections = legsOfKind(
    await transfersByAccount(account),
    "adjustment",
  );
  expect(corrections.length).toBe(1);
  expect(corrections[0]!.amount).toBe(minorUnits(amount));
  expect(corrections[0]!.source).toEqual(from);
  expect(corrections[0]!.destination).toEqual(to);
};

Then(
  "the {word} difference was written off in one correction",
  async function (this: TicketsWorld, amount: string): Promise<void> {
    // Written down means out of the listing's earnings and into the write-off.
    const listing = revenueAccount(
      requiredWorldValue(this.listingId, "the listing"),
    );
    await expectOneCorrection(listing, amount, listing, WRITEOFF);
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

/** What the customer owes, both on the books and on the page they are shown. */
const expectOwed = async function (
  this: TicketsWorld,
  amount: string,
): Promise<void> {
  expect(await owedBy(bookingId(this))).toBe(minorUnits(amount));
  await assertRenderedOwed(bookingId(this), minorUnits(amount));
};

Then("they owe {word}, on the books and on their money page", expectOwed);

/** A listing earned this much, and one more thing is true alongside it. */
const earnedAnd = (alsoTrue: (world: TicketsWorld) => Promise<void>) =>
  async function (
    this: TicketsWorld,
    listing: string,
    amount: string,
  ): Promise<void> {
    expect(await incomeOf(listingIdNamed(this, listing))).toBe(
      minorUnits(amount),
    );
    await alsoTrue(this);
  };

Then(
  "the {word} has still earned {word}, and the money the site holds is unchanged",
  // A correction to what someone owes touches neither the listing's earnings
  // nor the cash the site holds.
  earnedAnd(async (world) => {
    expect(await worldBalance()).toBe(cashBefore(world));
  }),
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
  function (this: TicketsWorld, amount: string): Promise<void> {
    const page = `/admin/modifiers/${surchargeId(this)}/edit`;
    return correctEarnings(
      this,
      page,
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
    // Raising what it earned takes the difference out of the write-off.
    const surcharge = modifierAccount(surchargeId(this));
    await expectOneCorrection(surcharge, amount, WRITEOFF, surcharge);
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

Then("they still owe {word}, on the books and on their money page", expectOwed);

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
  "their payment link offers to take the {word} that is left",
  async function (this: TicketsWorld, amount: string): Promise<void> {
    const page = await balancePageHtml(this);
    expect(page).toContain(
      `Balance due:</strong> ${formatCurrency(minorUnits(amount))}`,
    );
    expect(page).toContain(`Pay ${formatCurrency(minorUnits(amount))} now`);
  },
);

Then(
  "it names the {word} place, {word} ordered and {word} paid",
  async function (
    this: TicketsWorld,
    name: string,
    ordered: string,
    paid: string,
  ): Promise<void> {
    const page = await balancePageHtml(this);
    expect(page).toContain(name);
    expect(page).toContain(
      `Full order price:</strong> ${formatCurrency(minorUnits(ordered))}`,
    );
    expect(page).toContain(
      `Already paid:</strong> ${formatCurrency(minorUnits(paid))}`,
    );
  },
);

Then(
  "it says nothing about who booked",
  async function (this: TicketsWorld): Promise<void> {
    const page = await balancePageHtml(this);
    // The booker's own name and address are what the link must not carry, so
    // a fixture that set neither would prove nothing rather than pass.
    for (const key of ["attendeeEmail", "attendeeName"] as const) {
      expect(page).not.toContain(requiredWorldValue(this[key], key));
    }
  },
);

Then(
  "the {word} earned {word} and the customer owes nothing",
  earnedAnd(async (world) => {
    expect(await owedBy(bookingId(world))).toBe(0);
  }),
);

Given(
  "the organiser corrected the {word} listing's income to {word}",
  correctListingIncome,
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
