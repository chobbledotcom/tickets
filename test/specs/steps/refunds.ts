// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import {
  attendeeAccount,
  BOOKING_FEE_INCOME,
  modifierAccount,
  WORLD,
} from "#shared/accounting/accounts.ts";
import {
  accountBalance,
  transfersByAccount,
} from "#shared/accounting/queries.ts";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { settings } from "#shared/db/settings.ts";
import {
  askForRefund,
  bookingId,
  buyOnePlace,
  expectRefundMessage,
  listingIdFor,
  minorUnits,
  sellPlacesAt,
  timesProviderWasAsked,
} from "#test/specs/support/money.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { createPaidTestAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { insertModifier } from "#test-utils/modifiers.ts";
import { runStripeSuccess } from "#test-utils/money/drivers.ts";
import {
  adminPageHtml,
  assertEditPageIncome,
  assertRenderedModifierRevenue,
  assertStatementBalance,
  attendeeLegsOfKind,
  incomeOf,
  kindsOf,
  legsOfKind,
  owedBy,
  sumOfAllBalances,
  worldBalance,
} from "#test-utils/money/reads.ts";
import { adminFormPost } from "#test-utils/session.ts";
import { setupStripe } from "#test-utils/settings.ts";

// jscpd:ignore-end

const CONCERT = "Concert";
const FEE_DAY = "Fee Day";
const TALK = "Talk";
const FESTIVAL = "Festival";
const SERVICE_CHARGE = "Service charge";

const refundPath = (world: TicketsWorld, page: string): string =>
  `/admin/attendees/${bookingId(world)}/${page}`;

/** Sell one place with an extra charge on top and pay the whole amount, the way
 * a real checkout does: the signed total must match what the site re-derives. */
const buyPlaceWithExtra = async (
  world: TicketsWorld,
  name: string,
  pounds: string,
  extraPounds: string,
  who: string,
  modifierId?: number,
): Promise<void> => {
  await setupStripe();
  // The story may already have put this listing on sale (with its extra charge
  // attached), so reuse it rather than selling a second one of the same name.
  const listingId =
    world.listingIds.get(name) ?? (await sellPlacesAt(world, name, pounds)).id;
  const price = minorUnits(pounds);
  await runStripeSuccess({
    email: `${who.toLowerCase().replaceAll(" ", ".")}@example.com`,
    items: JSON.stringify([{ e: listingId, p: price, q: 1 }]),
    ...(modifierId === undefined
      ? {}
      : { modifiers: [{ i: modifierId, q: 1 }] }),
    name: who,
    paymentIntent: `pi_${name.toLowerCase().replaceAll(" ", "_")}`,
    sessionId: `cs_${name.toLowerCase().replaceAll(" ", "_")}`,
    total: price + minorUnits(extraPounds),
  });
  world.attendeeId = (await getAttendeesRaw(listingId))[0]!.id;
  world.attendeeName = who;
};

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
  "a customer paid 45.00 for a Concert place",
  async function (this: TicketsWorld): Promise<void> {
    await buyOnePlace(this, CONCERT, "45.00", "Refundee");
    expect(await incomeOf(listingIdFor(this, CONCERT))).toBe(4500);
  },
);

When(
  "the organiser refunds the booking",
  function (this: TicketsWorld): Promise<void> {
    return askForRefund(this, true);
  },
);

Then(
  "the customer is handed back 45.00 once",
  async function (this: TicketsWorld): Promise<void> {
    await expectRefundMessage(
      this,
      refundPath(this, "actions"),
      "Refund issued",
      true,
    );
    expect(timesProviderWasAsked(this)).toBe(1);
    // One full refund of the whole payment, returned where it came from.
    const handedBack = await attendeeLegsOfKind(bookingId(this), "refund_cash");
    expect(handedBack.length).toBe(1);
    expect(handedBack[0]!.amount).toBe(4500);
    expect(handedBack[0]!.destination).toEqual(WORLD);
  },
);

Then(
  "the Concert has earned nothing and the customer owes nothing",
  async function (this: TicketsWorld): Promise<void> {
    const listingId = listingIdFor(this, CONCERT);
    expect(await incomeOf(listingId)).toBe(0);
    expect(await owedBy(bookingId(this))).toBe(0);
    expect(await sumOfAllBalances()).toBe(0);
    // The money record nets the refund; the listing's own income box reports
    // the sale less write-offs, so an ordinary refund leaves it standing.
    await assertStatementBalance(listingId, 0);
    await assertEditPageIncome(listingId, 4500);
  },
);

Then(
  "the booking page says the booking is fully paid",
  async function (this: TicketsWorld): Promise<void> {
    expect(await adminPageHtml(refundPath(this, "ledger"))).toContain(
      "This booking is fully paid",
    );
  },
);

Given(
  "a customer's paid Concert place was already refunded",
  async function (this: TicketsWorld): Promise<void> {
    await buyOnePlace(this, CONCERT, "45.00", "Logged Guest");
    await askForRefund(this, true);
    await expectRefundMessage(
      this,
      refundPath(this, "actions"),
      "Refund issued",
      true,
    );
    // The money event is on the customer's own history for anyone to see.
    expect(await adminPageHtml(refundPath(this, "activity"))).toContain(
      "Refund issued for attendee 'Logged Guest'",
    );
  },
);

When(
  "the organiser tries to refund it again",
  function (this: TicketsWorld): Promise<void> {
    return askForRefund(this, true);
  },
);

Then(
  "the organiser is told it was already refunded",
  async function (this: TicketsWorld): Promise<void> {
    await expectRefundMessage(
      this,
      refundPath(this, "refund"),
      "already been refunded",
      false,
    );
  },
);

Then(
  "the payment provider is not asked again",
  function (this: TicketsWorld): void {
    expect(timesProviderWasAsked(this)).toBe(0);
  },
);

Then(
  "the customer was handed money back only once",
  async function (this: TicketsWorld): Promise<void> {
    expect(
      (await attendeeLegsOfKind(bookingId(this), "refund_cash")).length,
    ).toBe(1);
    expect(await owedBy(bookingId(this))).toBe(0);
    expect(await sumOfAllBalances()).toBe(0);
  },
);

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
    expect(await incomeOf(listingIdFor(this, FEE_DAY))).toBe(5000);
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
    expect(await incomeOf(listingIdFor(this, FEE_DAY))).toBe(0);
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
    const listingId = listingIdFor(this, TALK);
    const modifierId = requiredWorldValue(this.modifierId, "modifier id");
    await runStripeSuccess({
      email: "svc@example.com",
      items: JSON.stringify([{ e: listingId, p: 5000, q: 1 }]),
      modifiers: [{ i: modifierId, q: 1 }],
      name: "Svc Buyer",
      paymentIntent: "pi_svc",
      sessionId: "cs_svc",
      total: 5500,
    });
    this.attendeeId = (await getAttendeesRaw(listingId))[0]!.id;
    this.attendeeName = "Svc Buyer";
  },
);

Then(
  "the Service charge has earned 5.00",
  async function (this: TicketsWorld): Promise<void> {
    const modifierId = requiredWorldValue(this.modifierId, "modifier id");
    expect(await accountBalance(modifierAccount(modifierId))).toBe(500);
    expect(await incomeOf(listingIdFor(this, TALK))).toBe(5000);
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

Then("no money is left unaccounted for", async (): Promise<void> => {
  expect(await sumOfAllBalances()).toBe(0);
});

Given(
  "Part One costs 30.00 and Part Two costs 20.00",
  async function (this: TicketsWorld): Promise<void> {
    await setupStripe();
    await sellPlacesAt(this, "Part One", "30.00");
    await sellPlacesAt(this, "Part Two", "20.00");
  },
);

When(
  "a customer pays 50.00 for one place on each",
  async function (this: TicketsWorld): Promise<void> {
    const first = listingIdFor(this, "Part One");
    await runStripeSuccess({
      email: "both@example.com",
      items: JSON.stringify([
        { e: first, p: 3000, q: 1 },
        { e: listingIdFor(this, "Part Two"), p: 2000, q: 1 },
      ]),
      name: "Both Buyer",
      paymentIntent: "pi_multi",
      sessionId: "cs_multi",
      total: 5000,
    });
    this.attendeeId = (await getAttendeesRaw(first))[0]!.id;
    this.attendeeName = "Both Buyer";
  },
);

Then(
  "Part One has earned 30.00 and Part Two has earned 20.00",
  async function (this: TicketsWorld): Promise<void> {
    expect(await incomeOf(listingIdFor(this, "Part One"))).toBe(3000);
    expect(await incomeOf(listingIdFor(this, "Part Two"))).toBe(2000);
    expect(await owedBy(bookingId(this))).toBe(0);
    expect(await worldBalance()).toBe(-5000);
    expect(await sumOfAllBalances()).toBe(0);
  },
);

Then(
  "both places belong to the same order",
  async function (this: TicketsWorld): Promise<void> {
    const legs = await transfersByAccount(attendeeAccount(bookingId(this)));
    expect(legsOfKind(legs, "sale").length).toBe(2);
    expect(new Set(legs.map((leg) => leg.eventGroup)).size).toBe(1);
  },
);

Then(
  "each listing's page shows its own earnings",
  async function (this: TicketsWorld): Promise<void> {
    await assertEditPageIncome(listingIdFor(this, "Part One"), 3000);
    await assertEditPageIncome(listingIdFor(this, "Part Two"), 2000);
  },
);

Given(
  "two customers each paid 70.00 for a Festival place",
  async function (this: TicketsWorld): Promise<void> {
    await buyOnePlace(this, FESTIVAL, "70.00", "Mixed One");
    await createPaidTestAttendee(
      listingIdFor(this, FESTIVAL),
      "Mixed Two",
      "mixed2@example.com",
      "pi_mix2",
      7000,
    );
    expect(await incomeOf(listingIdFor(this, FESTIVAL))).toBe(14000);
  },
);

Given(
  "the organiser corrected the Festival income to 100.00",
  async function (this: TicketsWorld): Promise<void> {
    const listingId = listingIdFor(this, FESTIVAL);
    const { response } = await adminFormPost(
      `/admin/listing/${listingId}/income`,
      { income: "100.00" },
    );
    expect(response.status).toBe(302);
    expect(await incomeOf(listingId)).toBe(10000);
  },
);

When(
  "the organiser refunds the first customer",
  function (this: TicketsWorld): Promise<void> {
    return askForRefund(this, true);
  },
);

Then(
  "the Festival earnings and the refunded customer's balance agree",
  async function (this: TicketsWorld): Promise<void> {
    const listingId = listingIdFor(this, FESTIVAL);
    expect(timesProviderWasAsked(this)).toBe(1);
    expect(await owedBy(bookingId(this))).toBe(0);
    // 140 sold − 40 written down − 70 refunded = 30 on the money record, while
    // the listing's income box ignores the refund and still reads 100.
    expect(await incomeOf(listingId)).toBe(3000);
    await assertStatementBalance(listingId, 3000);
    await assertEditPageIncome(listingId, 10000);
  },
);
