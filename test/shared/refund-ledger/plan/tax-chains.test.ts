import { assertRejects } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  attendeeAccount,
  revenueAccount,
  TAX_VAT,
  WORLD,
} from "#accounting/accounts.ts";
import { KIND } from "#accounting/kinds.ts";
import { listingMoneyTotals } from "#accounting/listing-money-totals.ts";
import { bookingEventGroup, mapRefund } from "#accounting/mappers.ts";
import {
  bookingSaleTotalSubquery,
  creditsLessWriteoffDebits,
  externalCashBalanceSubquery,
  orderTotalSubquery,
  reservationSubtotalSubquery,
} from "#accounting/projection-sql.ts";
import {
  accountBalance,
  ledgerTotals,
  transfersByAccount,
} from "#accounting/queries.ts";
import { emptyRange } from "#accounting/range.ts";
import { postTransferGroups, postTransfers } from "#accounting/store.ts";
import { balanceEventGroup } from "#db/attendees/balance.ts";
import { refundedForBooking } from "#db/attendees/select.ts";
import { execute, queryAll, queryOne } from "#db/client.ts";
import { updateTaxPolicy } from "#db/settings/tax.ts";
import { computeAttendeeRefund } from "#shared/refund-ledger/plan.ts";
import { recordAttendeeRefund } from "#shared/refund-ledger/record.ts";
import { assessTax } from "#shared/tax/assessment.ts";
import { NO_TAX, type TaxPolicy } from "#shared/tax/types.ts";
import {
  ATTENDEE,
  BOOKING_AT,
  postBooking,
  sessionReference,
} from "#test/shared/refund-ledger/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { refundLedgerResult } from "#test-utils/refund-ledger.ts";

const basis = { lines: [{ gross: 1000, listingId: 1 }], modifiers: [] };

/** No refund leg of any kind has been written for the attendee. */
const expectNoRefundLegs = async () => {
  expect(
    (await transfersByAccount(attendeeAccount(ATTENDEE))).some((leg) =>
      leg.kind?.startsWith("refund_"),
    ),
  ).toBe(false);
};

const assessment = async (
  revision: number,
  eventGroup: string,
  policy: TaxPolicy,
) => {
  await execute(
    "INSERT INTO booking_tax_assessments (booking_group, revision, attendee_id, event_group, state, assessment, occurred_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
    [
      await bookingEventGroup("tax-chain"),
      revision,
      ATTENDEE,
      eventGroup,
      JSON.stringify(assessTax(basis, policy)),
      BOOKING_AT,
    ],
  );
};

const postChain = async (unsettled = false) => {
  await postBooking({
    amountPaid: 1000,
    eventId: "tax-chain",
    lines: basis.lines,
  });
  await assessment(0, await bookingEventGroup("tax-chain"), NO_TAX);
  await postTransfers([
    {
      amount: 167,
      destination: attendeeAccount(ATTENDEE),
      eventGroup: "tax-correction-1",
      kind: KIND.taxSale,
      occurredAt: BOOKING_AT,
      reference: "tax-sale-1",
      source: revenueAccount(1),
    },
    {
      amount: 167,
      destination: TAX_VAT,
      eventGroup: "tax-correction-1",
      kind: KIND.vat,
      occurredAt: BOOKING_AT,
      reference: "tax-vat-1",
      source: attendeeAccount(ATTENDEE),
    },
  ]);
  await assessment(1, "tax-correction-1", {
    mode: "calculate_from_total",
    rateBasisPoints: 2000,
  });
  await postTransfers([
    {
      amount: unsettled ? 167 : 76,
      destination: revenueAccount(1),
      eventGroup: "tax-correction-2",
      kind: KIND.taxSale,
      occurredAt: BOOKING_AT,
      reference: "tax-sale-2",
      source: attendeeAccount(ATTENDEE),
    },
    {
      amount: unsettled ? 67 : 76,
      destination: attendeeAccount(ATTENDEE),
      eventGroup: "tax-correction-2",
      kind: KIND.vat,
      occurredAt: BOOKING_AT,
      reference: "tax-vat-2",
      source: TAX_VAT,
    },
  ]);
  await assessment(2, "tax-correction-2", {
    mode: unsettled ? "add_to_total" : "calculate_from_total",
    rateBasisPoints: 1000,
  });
};

const expectChainCleared = async () => {
  expect(await accountBalance(attendeeAccount(ATTENDEE))).toBe(0);
  expect(await accountBalance(revenueAccount(1))).toBe(0);
  expect(await accountBalance(TAX_VAT)).toBe(0);
  const states = await queryAll<{ state: string }>(
    "SELECT state FROM booking_tax_assessments ORDER BY revision DESC LIMIT 1",
  );
  expect(states[0]!.state).toBe("refunded");
};

const bookingRefunded = async () => {
  const group = await bookingEventGroup("tax-chain");
  return (await queryOne<{ value: number }>(
    `SELECT ${refundedForBooking({
      attendeeId: String(ATTENDEE),
      eventGroup: `'${group}'`,
      listingId: "1",
      placeholderWhen: "0",
    })} AS value`,
  ))!.value;
};

describeWithEnv("refund ledger > tax assessment chains", { db: true }, () => {
  setupErrorSpy();
  test("reverses every physical correction exactly, closes the assessment, and replays without more rows", async () => {
    await postChain();
    const assessedLegs = await transfersByAccount(attendeeAccount(ATTENDEE));
    await updateTaxPolicy({ mode: "add_to_total", rateBasisPoints: 10000 });
    expect(await transfersByAccount(attendeeAccount(ATTENDEE))).toEqual(
      assessedLegs,
    );
    const reference = sessionReference("tax-chain");
    expect(await recordAttendeeRefund(ATTENDEE, [reference])).toEqual(
      refundLedgerResult([reference]),
    );
    await expectChainCleared();
    const before = await transfersByAccount(attendeeAccount(ATTENDEE));
    expect(
      before.filter((leg) => leg.kind === KIND.refundTaxSale),
    ).toHaveLength(2);
    expect(await recordAttendeeRefund(ATTENDEE, [reference])).toEqual(
      refundLedgerResult([reference]),
    );
    expect(await transfersByAccount(attendeeAccount(ATTENDEE))).toEqual(before);
  });

  test("repairs an original-only reversal instead of reporting the tax chain recorded", async () => {
    await postChain();
    const original = (
      await transfersByAccount(attendeeAccount(ATTENDEE))
    ).filter(
      (leg) =>
        leg.eventGroup !== "tax-correction-1" &&
        leg.eventGroup !== "tax-correction-2",
    );
    await postTransfers(
      await mapRefund({ occurredAt: BOOKING_AT, orderLegs: original }),
    );
    expect(await bookingRefunded()).toBe(0);
    const reference = sessionReference("tax-chain");
    expect(await recordAttendeeRefund(ATTENDEE, [reference])).toEqual(
      refundLedgerResult([reference]),
    );
    await expectChainCleared();
    expect(await bookingRefunded()).toBe(1);
  });

  test("keeps an unpaid added-tax chain for review when another reference is still with the provider", async () => {
    await postChain(true);
    await postBooking({
      amountPaid: 1000,
      eventId: "other-booking",
      lines: [{ gross: 1000, listingId: 2 }],
    });
    const reference = sessionReference("tax-chain");
    expect(await recordAttendeeRefund(ATTENDEE, [reference])).toEqual(
      refundLedgerResult([], [reference], [reference]),
    );
    await expectNoRefundLegs();
    expect(await accountBalance(TAX_VAT)).toBe(100);
  });

  test("keeps balance-payment attribution until both references return", async () => {
    await postChain(true);
    await postTransfers([
      {
        amount: 100,
        destination: attendeeAccount(ATTENDEE),
        eventGroup: await balanceEventGroup("tax-balance"),
        kind: KIND.payment,
        occurredAt: BOOKING_AT,
        reference: "tax-balance-payment",
        source: WORLD,
      },
    ]);
    const booking = sessionReference("tax-chain");
    const balance = sessionReference("tax-balance");
    expect(await recordAttendeeRefund(ATTENDEE, [booking])).toEqual(
      refundLedgerResult([], [booking], [booking]),
    );
    expect(await recordAttendeeRefund(ATTENDEE, [booking, balance])).toEqual(
      refundLedgerResult([booking, balance]),
    );
    await expectChainCleared();
    const cash = (await transfersByAccount(attendeeAccount(ATTENDEE))).filter(
      (leg) => leg.kind === KIND.refundCash,
    );
    expect(cash.map(({ amount }) => amount).sort((a, b) => a - b)).toEqual([
      100, 1000,
    ]);
  });

  test("rejects a stale refund before writing any chain reversal", async () => {
    await postChain();
    const computed = await computeAttendeeRefund({
      attendeeId: ATTENDEE,
      references: [sessionReference("tax-chain")],
    });
    await assessment(3, "another-correction", NO_TAX);
    await assertRejects(() =>
      postTransferGroups(computed.groups, computed.statements),
    );
    await expectNoRefundLegs();
    expect(await accountBalance(TAX_VAT)).toBe(91);
  });

  test("fences the first assessment added to a legacy booking during refund preparation", async () => {
    await postBooking({
      amountPaid: 1000,
      eventId: "tax-chain",
      lines: basis.lines,
    });
    const computed = await computeAttendeeRefund({
      attendeeId: ATTENDEE,
      references: [sessionReference("tax-chain")],
    });
    await assessment(0, await bookingEventGroup("tax-chain"), NO_TAX);
    await assertRejects(() =>
      postTransferGroups(computed.groups, computed.statements),
    );
    await expectNoRefundLegs();
  });

  test("rolls assessment closure back when the atomic refund batch fails", async () => {
    await postChain();
    const computed = await computeAttendeeRefund({
      attendeeId: ATTENDEE,
      references: [sessionReference("tax-chain")],
    });
    await assertRejects(() =>
      postTransferGroups(computed.groups, [
        ...computed.statements,
        { args: [], sql: "INSERT INTO missing_refund_test_table VALUES (1)" },
      ]),
    );
    const states = await queryAll<{ state: string }>(
      "SELECT state FROM booking_tax_assessments",
    );
    expect(states.every(({ state }) => state === "active")).toBe(true);
    expect(
      (await transfersByAccount(attendeeAccount(ATTENDEE))).some((leg) =>
        leg.kind?.startsWith("refund_"),
      ),
    ).toBe(false);
  });

  test("does not call an incomplete physical correction reversal recorded", async () => {
    await postChain();
    const original = (
      await transfersByAccount(attendeeAccount(ATTENDEE))
    ).filter((leg) => leg.eventGroup === "tax-correction-1");
    const partial = await mapRefund({
      occurredAt: BOOKING_AT,
      orderLegs: original,
    });
    await postTransfers(partial.slice(0, 1));
    const reference = sessionReference("tax-chain");
    expect(await recordAttendeeRefund(ATTENDEE, [reference])).toEqual(
      refundLedgerResult([], [reference]),
    );
    const states = await queryAll<{ state: string }>(
      "SELECT state FROM booking_tax_assessments",
    );
    expect(states.every(({ state }) => state === "active")).toBe(true);
    expect(await bookingRefunded()).toBe(0);
  });

  test("reports signed tax income without altering cash, and refunds the corrected income", async () => {
    await postChain();
    const group = await bookingEventGroup("tax-chain");
    const row = await queryOne<Record<string, number>>(`SELECT
      ${bookingSaleTotalSubquery(String(ATTENDEE), "1", `'${group}'`)} AS price,
      ${creditsLessWriteoffDebits("revenue", "1")} AS income,
      ${orderTotalSubquery("attendee", String(ATTENDEE))} AS total,
      ${reservationSubtotalSubquery("attendee", String(ATTENDEE))} AS deposit_base,
      ${externalCashBalanceSubquery("attendee", String(ATTENDEE))} AS cash`);
    expect(row).toEqual({
      cash: 1000,
      deposit_base: 1000,
      income: 909,
      price: 909,
      total: 1000,
    });
    expect((await ledgerTotals(emptyRange)).income).toBe(909);
    const before = await listingMoneyTotals(emptyRange, [1]);
    expect(before.recognisedIncome).toBe(909);
    expect(before.manualAdjustments).toBe(0);
    await recordAttendeeRefund(ATTENDEE, [sessionReference("tax-chain")]);
    const after = await listingMoneyTotals(emptyRange, [1]);
    expect(after.recognisedIncome).toBe(909);
    expect(after.refunds).toBe(909);
    expect(after.netBalance).toBe(0);
    expect(
      (await queryOne<{ value: number }>(
        `SELECT ${creditsLessWriteoffDebits("revenue", "1")} AS value`,
      ))!.value,
    ).toBe(909);
  });
});
