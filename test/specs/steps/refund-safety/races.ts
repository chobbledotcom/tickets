// jscpd:ignore-start
import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { getAttendeeRaw } from "#shared/db/attendees/queries.ts";
import { queryAll } from "#shared/db/client.ts";
import { expectCanReallySend } from "#test/specs/support/form-controls/rules.ts";
import {
  buyDuplicateFreePlace,
  choosePaidDetails,
  expectBothBookingsPresent,
  openMergeChoicesInSecondWindow,
  rememberMovedPaymentWork,
  submitKeptMerge,
} from "#test/specs/support/refund-safety/merge-window.ts";
import {
  refundSafety,
  safetyBooking,
} from "#test/specs/support/refund-safety/state.ts";
import {
  logInOwnerWindows,
  openDeleteInSecondWindow,
  openRefundFormsInTwoWindows,
  openRefundInFirstWindow,
  type RefundWindows,
  releaseAndWait,
  startRefundAndWait,
  submitSecond,
} from "#test/specs/support/refund-safety/windows.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { acceptedRefund } from "#test-utils/payment-state.ts";
import {
  expectPaidWithoutRefund,
  expectProviderSendCount,
  paymentReferencesFor,
  refundProviderFor,
  untouchedChargeFor,
} from "./common.ts";

// jscpd:ignore-end

const windowsFor = (world: TicketsWorld): RefundWindows => {
  const windows = refundSafety(world).windows;
  if (windows === undefined) {
    throw new Error("The owner has not signed in through two browsers");
  }
  return windows;
};

const expectBrowserSays = (
  world: TicketsWorld,
  which: "first" | "second",
  words: string,
): void => {
  expect(windowsFor(world)[which].pageText).toContain(words);
};

Given(
  "the owner signs in through two separate browsers",
  async function (this: TicketsWorld): Promise<void> {
    refundSafety(this).windows = await logInOwnerWindows();
  },
);

Given(
  /^opens (\w+)'s refund confirmation in both browsers$/,
  function (this: TicketsWorld, who: string): Promise<RefundWindows> {
    const booking = safetyBooking(this, who);
    return openRefundFormsInTwoWindows(
      windowsFor(this),
      booking.attendeeId,
      who,
    );
  },
);

Given(
  /^opens (?:the paid )?(\w+)'s refund confirmation in the first browser$/,
  function (this: TicketsWorld, who: string): Promise<RefundWindows> {
    const booking = safetyBooking(this, who);
    return openRefundInFirstWindow(windowsFor(this), booking.attendeeId, who);
  },
);

Given(
  /^opens (\w+)'s delete confirmation in the second browser$/,
  function (this: TicketsWorld, who: string): Promise<RefundWindows> {
    const booking = safetyBooking(this, who);
    return openDeleteInSecondWindow(windowsFor(this), booking.attendeeId, who);
  },
);

Given(
  "types {word}'s exact name into both rendered forms",
  function (this: TicketsWorld, who: string): void {
    const forms = windowsFor(this).forms;
    if (forms?.second === undefined) {
      throw new Error("Both owner forms have not been rendered");
    }
    for (const form of [forms.first, forms.second]) {
      expect(form.typedValues).toEqual({ confirm_identifier: who });
      expectCanReallySend(form.formHtml, form.typedValues);
    }
  },
);

When(
  "the first browser submits and Stripe pauses before answering",
  async function (this: TicketsWorld): Promise<void> {
    const who = safetyBooking(this, "Alice").who;
    const booking = safetyBooking(this, who);
    const provider = refundProviderFor(this);
    const charge = untouchedChargeFor(this, who);
    provider.showCharge("stripe", booking.paymentReference, charge);
    const pause = provider.pause(
      "stripe",
      booking.paymentReference,
      acceptedRefund(charge),
    );
    await startRefundAndWait(windowsFor(this), pause, this.cleanup);
  },
);

When(
  "the second browser submits while Stripe is still paused",
  function (this: TicketsWorld): Promise<unknown> {
    return submitSecond(windowsFor(this));
  },
);

When(
  "the second browser presses Delete Attendee while Stripe is still paused",
  function (this: TicketsWorld): Promise<unknown> {
    return submitSecond(windowsFor(this));
  },
);

When(
  /^Stripe finishes accepting the (?:first request|refund)$/,
  function (this: TicketsWorld): Promise<unknown> {
    return releaseAndWait(windowsFor(this));
  },
);

Then(
  "one browser says the refund is still settling",
  function (this: TicketsWorld): void {
    expectBrowserSays(this, "first", "still settling");
  },
);

Then(
  "the other browser says another refund is still in progress",
  function (this: TicketsWorld): void {
    expectBrowserSays(this, "second", "still settling");
  },
);

Then(
  "the second browser is told {word} cannot be deleted yet",
  function (this: TicketsWorld, who: string): void {
    expect(safetyBooking(this, who).attendeeId).toBeGreaterThan(0);
    expectBrowserSays(
      this,
      "second",
      "refund for this person is still in progress",
    );
  },
);

Then(
  "{word}'s booking and payment are still present",
  async function (this: TicketsWorld, who: string): Promise<void> {
    const booking = safetyBooking(this, who);
    const [attendee, rows, references] = await Promise.all([
      getAttendeeRaw(booking.attendeeId),
      queryAll<{ attendee_id: number; listing_id: number }>(
        `SELECT attendee_id, listing_id FROM listing_attendees
         WHERE attendee_id = ? AND listing_id = ?`,
        [booking.attendeeId, booking.listingId],
      ),
      paymentReferencesFor(this, who),
    ]);
    expect(attendee?.id).toBe(booking.attendeeId);
    expect(rows).toEqual([
      {
        attendee_id: booking.attendeeId,
        listing_id: booking.listingId,
      },
    ]);
    expect(references.map(({ reference }) => reference)).toEqual([
      booking.paymentReference,
    ]);
    await expectPaidWithoutRefund(this, who, (booking.amount / 100).toFixed(2));
  },
);

Given(
  "another {word} bought a free {word} place through the public page",
  function (
    this: TicketsWorld,
    who: string,
    listingName: string,
  ): Promise<void> {
    return buyDuplicateFreePlace(this, who, listingName);
  },
);

Given(
  "opens the rendered merge choices in the second browser",
  function (this: TicketsWorld): Promise<void> {
    return openMergeChoicesInSecondWindow(this, windowsFor(this));
  },
);

Given(
  "chooses to keep every paid {word} detail in the merge form",
  function (this: TicketsWorld, _who: string): void {
    choosePaidDetails(this, windowsFor(this));
  },
);

When(
  "the second browser presses Merge and delete source attendee",
  function (this: TicketsWorld): Promise<unknown> {
    return submitKeptMerge(this, windowsFor(this));
  },
);

Then(
  "the second browser is told the bookings cannot be merged yet",
  function (this: TicketsWorld): void {
    expectBrowserSays(
      this,
      "second",
      "refund for this person is still in progress",
    );
  },
);

Then(
  "both {word}s and both bookings are still present",
  function (this: TicketsWorld, who: string): Promise<void> {
    return expectBothBookingsPresent(this, who);
  },
);

Then(
  "the returned payment work moves onto the free {word} without a legacy payment ID",
  function (this: TicketsWorld, who: string): Promise<void> {
    return rememberMovedPaymentWork(this, who);
  },
);

Then(
  "Money still shows the paid {word}'s {float} payment",
  function (this: TicketsWorld, who: string, pounds: number): Promise<void> {
    return expectPaidWithoutRefund(this, who, pounds.toFixed(2));
  },
);

Then(
  /^Stripe received one request to return the paid (\w+)'s money$/,
  function (this: TicketsWorld, who: string): void {
    expectProviderSendCount(this, "stripe", who, 1);
  },
);
