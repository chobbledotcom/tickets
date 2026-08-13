// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { listingIdNamed } from "#test/specs/support/listings.ts";
import {
  askForRefund,
  bookingId,
  bookingPagePath,
  buyOnePlace,
  expectMoneyHandedBack,
  expectRefundMessage,
  timesProviderWasAsked,
} from "#test/specs/support/money.ts";
import {
  adminPageHtml,
  assertEditPageIncome,
  assertStatementBalance,
  attendeeLegsOfKind,
  incomeOf,
  owedBy,
  sumOfAllBalances,
} from "#test/specs/support/money-reads.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";

// jscpd:ignore-end

const CONCERT = "Concert";

When(
  "the organiser refunds the booking",
  function (this: TicketsWorld): Promise<void> {
    return askForRefund(this, true);
  },
);

Then(
  "the customer is handed back 45.00 once",
  async function (this: TicketsWorld): Promise<void> {
    expectRefundMessage(
      this,
      bookingPagePath(this, "actions"),
      "Refund issued",
    );
    await expectMoneyHandedBack(this, 4500);
  },
);

Then(
  "the Concert has earned nothing and the customer owes nothing",
  async function (this: TicketsWorld): Promise<void> {
    const listingId = listingIdNamed(this, CONCERT);
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
    expect(await adminPageHtml(bookingPagePath(this, "ledger"))).toContain(
      "This booking is fully paid",
    );
  },
);

Given(
  "a customer's paid Concert place was already refunded",
  async function (this: TicketsWorld): Promise<void> {
    await buyOnePlace(this, CONCERT, "45.00", "Logged Guest");
    await askForRefund(this, true);
    expectRefundMessage(
      this,
      bookingPagePath(this, "actions"),
      "Refund issued",
    );
    // The money event is on the customer's own history for anyone to see.
    expect(await adminPageHtml(bookingPagePath(this, "activity"))).toContain(
      "Refund issued",
    );
    expect(await adminPageHtml(bookingPagePath(this, "activity"))).not.toContain(
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
    expectRefundMessage(
      this,
      bookingPagePath(this, "refund"),
      "already been refunded",
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
