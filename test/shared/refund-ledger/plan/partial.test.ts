import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  attendeeAccount,
  revenueAccount,
  WORLD,
} from "#shared/accounting/accounts.ts";
import { KIND } from "#shared/accounting/kinds.ts";
import { bookingEventGroup } from "#shared/accounting/mappers.ts";
import {
  accountBalance,
  transfersByAccount,
} from "#shared/accounting/queries.ts";
import { legReference } from "#shared/accounting/refs.ts";
import { postTransfers } from "#shared/accounting/store.ts";
import { balanceEventGroup } from "#shared/db/attendees/balance.ts";
import { recordAttendeeRefund } from "#shared/refund-ledger/record.ts";
import {
  ATTENDEE,
  BOOKING_AT,
  postBooking,
  refundCashAmounts,
  refundLegsOf,
  returnedReference,
  sessionReference,
} from "#test/shared/refund-ledger/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { refundLedgerResult } from "#test-utils/refund-ledger.ts";

const postBalancePayment = async (): Promise<void> => {
  await postTransfers([
    {
      amount: 2000,
      destination: attendeeAccount(ATTENDEE),
      eventGroup: await balanceEventGroup("balance-session"),
      kind: KIND.payment,
      occurredAt: BOOKING_AT,
      reference: "balance-pay",
      source: WORLD,
    },
  ]);
};

const postSafeAndUnsafeBookings = async (): Promise<void> => {
  await postBooking({
    amountPaid: 1000,
    eventId: "safe-session",
    lines: [{ gross: 1000, listingId: 1 }],
  });
  await postBooking({
    amountPaid: 1000,
    eventId: "unsafe-session",
    lines: [{ gross: 3000, listingId: 2 }],
  });
};

const postMixedSafetyAccount = async () => {
  await postSafeAndUnsafeBookings();
  await postBalancePayment();
  return returnedReference("pi-multi", ["safe-session", "unsafe-session"]);
};

const safeAndUnsafeReferences = () => ({
  safe: sessionReference("safe-session"),
  unsafe: sessionReference("unsafe-session"),
});

const expectSafeRecordedAndUnsafeReview = async (
  safe: ReturnType<typeof sessionReference>,
  unsafe: ReturnType<typeof sessionReference>,
): Promise<void> => {
  expect(await recordAttendeeRefund(ATTENDEE, [safe, unsafe])).toEqual(
    refundLedgerResult([safe], [unsafe], [unsafe]),
  );
  expect(await refundCashAmounts()).toEqual([1000]);
};

const expectOnlySafeGroupWasReversed = async (): Promise<void> => {
  expect(await refundCashAmounts()).toEqual([1000]);
  expect(await accountBalance(revenueAccount(1))).toBe(0);
  expect(await accountBalance(revenueAccount(2))).toBe(3000);
};

describeWithEnv("refund ledger > partial returns", { db: true }, () => {
  const errors = setupErrorSpy();

  test("does not cancel an underfunded booking when only its deposit came back", async () => {
    await postBooking({
      amountPaid: 1000,
      eventId: "deposit-session",
      lines: [{ gross: 3000, listingId: 1 }],
    });
    const deposit = sessionReference("deposit-session");

    expect(await recordAttendeeRefund(ATTENDEE, [deposit])).toEqual(
      refundLedgerResult([], [deposit], [deposit]),
    );
    expect(
      refundLegsOf(await transfersByAccount(attendeeAccount(ATTENDEE))),
    ).toEqual([]);
    expect(await accountBalance(revenueAccount(1))).toBe(3000);
  });

  test("posts a safe return while an underfunded sibling waits for review", async () => {
    await postSafeAndUnsafeBookings();
    const { safe, unsafe } = safeAndUnsafeReferences();

    await expectSafeRecordedAndUnsafeReview(safe, unsafe);
    await expectOnlySafeGroupWasReversed();
  });

  test("keeps an earlier safe reversal when a returned sibling needs review", async () => {
    await postSafeAndUnsafeBookings();
    const { safe, unsafe } = safeAndUnsafeReferences();
    await recordAttendeeRefund(ATTENDEE, [safe]);

    await expectSafeRecordedAndUnsafeReview(safe, unsafe);
  });

  test("keeps a multi-booking reference open until every named group is safe", async () => {
    const returned = await postMixedSafetyAccount();

    expect(await recordAttendeeRefund(ATTENDEE, [returned])).toEqual(
      refundLedgerResult([], [returned], [returned]),
    );
    await expectOnlySafeGroupWasReversed();
  });

  test("keeps the obligation review when a safe reversal cannot be posted", async () => {
    const returned = await postMixedSafetyAccount();
    const safeEventGroup = await bookingEventGroup("safe-session");
    const safeSale = (await transfersByAccount(attendeeAccount(ATTENDEE))).find(
      (leg) => leg.kind === KIND.sale && leg.eventGroup === safeEventGroup,
    );
    if (safeSale === undefined) {
      throw new Error("The safe booking sale is missing");
    }
    await postTransfers([
      {
        amount: 1,
        destination: revenueAccount(99),
        eventGroup: "refund-reference-blocker",
        kind: KIND.sale,
        occurredAt: BOOKING_AT,
        reference: await legReference([
          "refund",
          safeSale.eventGroup,
          safeSale.reference,
        ]),
        source: attendeeAccount(99),
      },
    ]);

    expect(await recordAttendeeRefund(ATTENDEE, [returned])).toEqual(
      refundLedgerResult([], [returned], [returned]),
    );
    expect(await refundCashAmounts()).toEqual([]);
    expect(errors.lastMessage()).toContain("refund ledger post failed");
  });

  test("keeps an earlier exact reversal recorded when a sibling post fails", async () => {
    await postBooking({
      amountPaid: 1000,
      eventId: "already-recorded",
      lines: [{ gross: 1000, listingId: 1 }],
    });
    await postBooking({
      amountPaid: 1000,
      eventId: "post-fails",
      lines: [{ gross: 1000, listingId: 2 }],
    });
    const alreadyRecorded = sessionReference("already-recorded");
    const postFails = sessionReference("post-fails");
    await recordAttendeeRefund(ATTENDEE, [alreadyRecorded]);

    const failedEventGroup = await bookingEventGroup("post-fails");
    const failedSale = (
      await transfersByAccount(attendeeAccount(ATTENDEE))
    ).find(
      (leg) => leg.kind === KIND.sale && leg.eventGroup === failedEventGroup,
    );
    if (failedSale === undefined) {
      throw new Error("The booking sale whose refund must fail is missing");
    }
    await postTransfers([
      {
        amount: 1,
        destination: revenueAccount(98),
        eventGroup: "sibling-refund-reference-blocker",
        kind: KIND.sale,
        occurredAt: BOOKING_AT,
        reference: await legReference([
          "refund",
          failedSale.eventGroup,
          failedSale.reference,
        ]),
        source: attendeeAccount(98),
      },
    ]);

    expect(
      await recordAttendeeRefund(ATTENDEE, [alreadyRecorded, postFails]),
    ).toEqual(refundLedgerResult([alreadyRecorded], [postFails]));
    expect(await refundCashAmounts()).toEqual([1000]);
  });
});
