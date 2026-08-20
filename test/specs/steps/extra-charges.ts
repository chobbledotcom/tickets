// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import {
  attendeeAccount,
  BOOKING_FEE_INCOME,
  modifierAccount,
} from "#accounting/accounts.ts";
import { accountBalance, transfersByAccount } from "#accounting/queries.ts";
import { settings } from "#db/settings.ts";
import { listingIdNamed } from "#test/specs/support/listings.ts";
import {
  bookingId,
  buyPlaceWithExtra,
  expectMoneyHandedBack,
  sellPlacesAt,
} from "#test/specs/support/money.ts";
import { runStripeSuccess } from "#test/specs/support/money-drivers.ts";
import {
  assertRenderedModifierRevenue,
  attendeeLegsOfKind,
  incomeOf,
  kindsOf,
  legsOfKind,
  owedBy,
  sumOfAllBalances,
  worldBalance,
} from "#test/specs/support/money-reads.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { insertModifier } from "#test-utils/modifiers.ts";
import { setupStripe } from "#test-utils/settings.ts";

// jscpd:ignore-end

const FEE_DAY = "Fee Day";
const TALK = "Talk";
const SERVICE_CHARGE = "Service charge";

/** Add the Service charge the Talk scenarios both use. */
const addServiceCharge = async (world: TicketsWorld): Promise<number> => {
  const modifier = await insertModifier({
    calcKind: "percent",
    calcValue: 10,
    name: SERVICE_CHARGE,
  });
  world.modifierId = modifier.id;
  return modifier.id;
};

Given(
  "the site adds a 10 percent booking fee",
  async function (this: TicketsWorld): Promise<void> {
    await settings.update.bookingFee("10");
  },
);

When(
  "a customer pays 55.00 for a 50.00 Fee Day place",
  function (this: TicketsWorld): Promise<void> {
    return buyPlaceWithExtra(this, FEE_DAY, "50.00", "5.00", "Fee Payer");
  },
);

Then(
  "the Fee Day place has earned 50.00 and the booking fee has earned 5.00",
  async function (this: TicketsWorld): Promise<void> {
    expect(await incomeOf(listingIdNamed(this, FEE_DAY))).toBe(5000);
    expect(await accountBalance(BOOKING_FEE_INCOME)).toBe(500);
    expect(await worldBalance()).toBe(-5500);
    // The fee is its own line on the booking, not part of the ticket's price.
    const legs = await transfersByAccount(attendeeAccount(bookingId(this)));
    expect(kindsOf(legs)).toEqual(["fee", "payment", "sale"]);
    const fee = legsOfKind(legs, "fee")[0]!;
    expect(fee.amount).toBe(500);
    expect(fee.destination).toEqual(BOOKING_FEE_INCOME);
  },
);

Then(
  "the customer owes nothing",
  async function (this: TicketsWorld): Promise<void> {
    expect(await owedBy(bookingId(this))).toBe(0);
  },
);

Given(
  "a customer paid a 10 percent booking fee on a 50.00 Fee Day place",
  async function (this: TicketsWorld): Promise<void> {
    await settings.update.bookingFee("10");
    await buyPlaceWithExtra(this, FEE_DAY, "50.00", "5.00", "Fee Payer");
    expect(await accountBalance(BOOKING_FEE_INCOME)).toBe(500);
  },
);

Then(
  "the Fee Day place and the booking fee have both earned nothing",
  async function (this: TicketsWorld): Promise<void> {
    expect(await incomeOf(listingIdNamed(this, FEE_DAY))).toBe(0);
    expect(await accountBalance(BOOKING_FEE_INCOME)).toBe(0);
    const handedBackFee = await attendeeLegsOfKind(
      bookingId(this),
      "refund_fee",
    );
    expect(handedBackFee.length).toBe(1);
    expect(handedBackFee[0]!.amount).toBe(500);
  },
);

Then(
  "the site is holding none of the customer's money",
  async function (this: TicketsWorld): Promise<void> {
    expect(await owedBy(bookingId(this))).toBe(0);
    expect(await worldBalance()).toBe(0);
    expect(await sumOfAllBalances()).toBe(0);
  },
);

Given(
  "a Talk place costs 50.00 and adds a 10 percent Service charge",
  async function (this: TicketsWorld): Promise<void> {
    await setupStripe();
    await sellPlacesAt(this, TALK, "50.00");
    await addServiceCharge(this);
  },
);

When(
  "a customer pays for one Talk place",
  async function (this: TicketsWorld): Promise<void> {
    const listingId = listingIdNamed(this, TALK);
    const modifierId = requiredWorldValue(this.modifierId, "modifier id");
    this.attendeeId = await runStripeSuccess(this, {
      email: "svc@example.com",
      items: JSON.stringify([{ e: listingId, p: 5000, q: 1 }]),
      modifiers: [{ i: modifierId, q: 1 }],
      name: "Svc Buyer",
      paymentIntent: "pi_svc",
      sessionId: "cs_svc",
      total: 5500,
    });
    this.attendeeName = "Svc Buyer";
  },
);

Then(
  "the Service charge has earned 5.00",
  async function (this: TicketsWorld): Promise<void> {
    const modifierId = requiredWorldValue(this.modifierId, "modifier id");
    expect(await accountBalance(modifierAccount(modifierId))).toBe(500);
    expect(await incomeOf(listingIdNamed(this, TALK))).toBe(5000);
    expect(await owedBy(bookingId(this))).toBe(0);
    // The charge is its own line, paid to the charge itself.
    const legs = await transfersByAccount(attendeeAccount(bookingId(this)));
    expect(kindsOf(legs)).toEqual(["modifier", "payment", "sale"]);
    const charge = legsOfKind(legs, "modifier")[0]!;
    expect(charge.amount).toBe(500);
    expect(charge.destination).toEqual(modifierAccount(modifierId));
  },
);

Then(
  "the organiser's pages show the Service charge earnings",
  async function (this: TicketsWorld): Promise<void> {
    await assertRenderedModifierRevenue(
      requiredWorldValue(this.modifierId, "modifier id"),
      500,
    );
  },
);

Given(
  "a customer paid a 10 percent Service charge on a 50.00 Talk place",
  async function (this: TicketsWorld): Promise<void> {
    await setupStripe();
    await sellPlacesAt(this, TALK, "50.00");
    const modifierId = await addServiceCharge(this);
    await buyPlaceWithExtra(
      this,
      TALK,
      "50.00",
      "5.00",
      "Svc Buyer",
      modifierId,
    );
    expect(await accountBalance(modifierAccount(modifierId))).toBe(500);
  },
);

Then(
  "the Service charge has earned nothing",
  async function (this: TicketsWorld): Promise<void> {
    const modifierId = requiredWorldValue(this.modifierId, "modifier id");
    expect(await accountBalance(modifierAccount(modifierId))).toBe(0);
    const handedBackCharge = await attendeeLegsOfKind(
      bookingId(this),
      "refund_modifier",
    );
    expect(handedBackCharge.length).toBe(1);
    expect(handedBackCharge[0]!.amount).toBe(500);
  },
);

Then(
  "the customer has the whole 55.00 back",
  async function (this: TicketsWorld): Promise<void> {
    // Undoing the charge on its own would leave the books balanced while the
    // customer still waited for their money, so the cash itself is checked:
    // the whole 55.00 goes back where it came from, once.
    await expectMoneyHandedBack(this, 5500);
    // Nobody is left holding anything: not the customer, not the site.
    expect(await owedBy(bookingId(this))).toBe(0);
    expect(await worldBalance()).toBe(0);
  },
);

Then("no money is left unaccounted for", async (): Promise<void> => {
  expect(await sumOfAllBalances()).toBe(0);
});
