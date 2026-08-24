import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeeAccount, WORLD } from "#accounting/accounts.ts";
import { bookingEventGroup } from "#accounting/mappers.ts";
import { transfersByAccount } from "#accounting/queries.ts";
import { legReference } from "#accounting/refs.ts";
import { postTransfers } from "#accounting/store.ts";
import { balanceOf } from "#shared/ledger/project.ts";
import { recordPlaceholderRefund } from "#shared/refund-ledger/placeholder.ts";
import { isPaymentOnlyAccount } from "#shared/refund-ledger/plan.ts";
import { BOOKING_AT } from "#test/shared/refund-ledger/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";

const PLACEHOLDER = {
  amount: 5000,
  attendeeId: 7,
  eventId: "ph-sess-1",
  listingId: 1,
  occurredAt: BOOKING_AT,
};

const paymentReference = (): Promise<string> =>
  legReference(["booking", PLACEHOLDER.eventId, "payment"]);

const refundReference = async (): Promise<string> =>
  legReference([
    "refund",
    await bookingEventGroup(PLACEHOLDER.eventId),
    await paymentReference(),
  ]);

describeWithEnv("refund-ledger > recordPlaceholderRefund", { db: true }, () => {
  const errors = setupErrorSpy();

  const blockLeg = async (
    eventGroup: string,
    reference: string,
  ): Promise<void> => {
    await postTransfers([
      {
        amount: 100,
        destination: attendeeAccount(99),
        eventGroup,
        kind: "payment",
        occurredAt: BOOKING_AT,
        reference,
        source: WORLD,
      },
    ]);
  };

  test("records the cash round-trip with no sale leg, netting to zero", async () => {
    expect(
      await recordPlaceholderRefund(PLACEHOLDER, "price_changed", true),
    ).toEqual({ posted: true });
    expect(
      isPaymentOnlyAccount(
        await transfersByAccount(attendeeAccount(PLACEHOLDER.attendeeId)),
      ),
    ).toBe(true);
    const legs = await transfersByAccount(
      attendeeAccount(PLACEHOLDER.attendeeId),
    );
    const cash = legs.filter((leg) => leg.kind === "refund_cash");
    expect(legs.map((leg) => leg.kind).sort()).toEqual([
      "payment",
      "refund_cash",
    ]);
    expect(cash.length).toBe(1);
    expect(cash[0]!.amount).toBe(PLACEHOLDER.amount);
    expect(cash[0]!.memo).toBe("price_changed");
    expect(balanceOf(attendeeAccount(PLACEHOLDER.attendeeId))(legs)).toBe(0);
  });

  test("posts only the payment when no refund completed", async () => {
    expect(
      await recordPlaceholderRefund(PLACEHOLDER, "charge_mismatch", false),
    ).toEqual({ posted: true });
    const legs = await transfersByAccount(
      attendeeAccount(PLACEHOLDER.attendeeId),
    );
    expect(legs.map((leg) => leg.kind)).toEqual(["payment"]);
    expect(balanceOf(attendeeAccount(PLACEHOLDER.attendeeId))(legs)).toBe(
      PLACEHOLDER.amount,
    );
  });

  test("rolls back the payment when the refund reference conflicts", async () => {
    await blockLeg("refund-blocker", await refundReference());

    expect(
      await recordPlaceholderRefund(PLACEHOLDER, "sold_out", true),
    ).toEqual({ posted: false });
    expect(
      await transfersByAccount(attendeeAccount(PLACEHOLDER.attendeeId)),
    ).toEqual([]);
    expect(errors.lastMessage()).toContain("E_LEDGER_POST");
    expect(errors.lastMessage()).toContain(
      "Placeholder refund ledger post failed",
    );
    expect(errors.lastMessage()).toContain("attendee=7");
  });

  test("logs and does not throw when the payment reference conflicts", async () => {
    await blockLeg("payment-blocker", await paymentReference());
    expect(
      await recordPlaceholderRefund(PLACEHOLDER, "sold_out", true),
    ).toEqual({ posted: false });
    expect(errors.lastMessage()).toContain("E_LEDGER_POST");
  });

  test("reports a payment-only conflict as not posted", async () => {
    await blockLeg("payment-only-blocker", await paymentReference());
    expect(
      await recordPlaceholderRefund(PLACEHOLDER, "charge_mismatch", false),
    ).toEqual({ posted: false });
    expect(errors.lastMessage()).toContain("E_LEDGER_POST");
  });
});
