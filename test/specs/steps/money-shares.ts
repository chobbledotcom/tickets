// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { attendeeAccount } from "#shared/accounting/accounts.ts";
import { transfersByAccount } from "#shared/accounting/queries.ts";
import {
  askForRefund,
  bookingId,
  buyOnePlace,
  correctIncomeTo,
  listingIdFor,
  sellPlacesAt,
  soleBookingOn,
  timesProviderWasAsked,
} from "#test/specs/support/money.ts";
import { runStripeSuccess } from "#test/specs/support/money-drivers.ts";
import {
  assertEditPageIncome,
  assertStatementBalance,
  incomeOf,
  legsOfKind,
  owedBy,
  sumOfAllBalances,
  worldBalance,
} from "#test/specs/support/money-reads.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { createPaidTestAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { setupStripe } from "#test-utils/settings.ts";

// jscpd:ignore-end

const FESTIVAL = "Festival";

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
    this.attendeeId = await soleBookingOn(first);
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
    // Both listings must hold the very same booking — money alone could add up
    // while one of the places was never given to anybody.
    const booking = bookingId(this);
    expect(await soleBookingOn(listingIdFor(this, "Part One"))).toBe(booking);
    expect(await soleBookingOn(listingIdFor(this, "Part Two"))).toBe(booking);
    const legs = await transfersByAccount(attendeeAccount(booking));
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
    await correctIncomeTo(this, listingId, "100.00");
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
