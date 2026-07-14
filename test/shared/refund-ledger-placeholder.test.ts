import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeeAccount, WORLD } from "#shared/accounting/accounts.ts";
import { bookingEventGroup } from "#shared/accounting/mappers.ts";
import { transfersByAccount } from "#shared/accounting/queries.ts";
import { legReference } from "#shared/accounting/refs.ts";
import { postTransfers } from "#shared/accounting/store.ts";
import { balanceOf } from "#shared/ledger/project.ts";
import { recordPlaceholderRefund } from "#shared/refund-ledger.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { BOOKING_AT } from "./refund-ledger/helpers.ts";

const PH = {
  amount: 5000,
  attendeeId: 7,
  eventId: "ph-sess-1",
  listingId: 1,
  occurredAt: BOOKING_AT,
};

const paymentReference = (): Promise<string> =>
  legReference(["booking", PH.eventId, "payment"]);

const refundReference = async (): Promise<string> =>
  legReference([
    "refund",
    await bookingEventGroup(PH.eventId),
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
    expect(await recordPlaceholderRefund(PH, "price_changed", true)).toEqual({
      posted: true,
    });
    const legs = await transfersByAccount(attendeeAccount(7));
    expect(legs.some((leg) => leg.kind === "sale")).toBe(false);
    expect(legs.some((leg) => leg.kind === "payment")).toBe(true);
    const cash = legs.filter((leg) => leg.kind === "refund_cash");
    expect(cash.length).toBe(1);
    expect(cash[0]!.amount).toBe(5000);
    expect(cash[0]!.memo).toBe("price_changed");
    expect(balanceOf(attendeeAccount(7))(legs)).toBe(0);
  });

  test("posts only the payment when the refund failed", async () => {
    expect(await recordPlaceholderRefund(PH, "charge_mismatch", false)).toEqual(
      { posted: true },
    );
    const legs = await transfersByAccount(attendeeAccount(7));
    expect(legs.map((leg) => leg.kind)).toEqual(["payment"]);
    expect(balanceOf(attendeeAccount(7))(legs)).toBe(5000);
  });

  test("rolls back the payment when the refund leg conflicts", async () => {
    await blockLeg("refund-blocker", await refundReference());

    expect(await recordPlaceholderRefund(PH, "sold_out", true)).toEqual({
      posted: false,
    });
    expect(await transfersByAccount(attendeeAccount(PH.attendeeId))).toEqual(
      [],
    );
    expect(errors.lastMessage()).toContain("E_LEDGER_POST");
  });

  test("logs and does not throw when the payment leg conflicts", async () => {
    await blockLeg("payment-blocker", await paymentReference());
    expect(await recordPlaceholderRefund(PH, "sold_out", true)).toEqual({
      posted: false,
    });
    expect(errors.lastMessage()).toContain("E_LEDGER_POST");
  });

  test("reports a held payment that never reached the ledger", async () => {
    await blockLeg("held-blocker", await paymentReference());
    expect(await recordPlaceholderRefund(PH, "stage_active", false)).toEqual({
      posted: false,
    });
    expect(errors.lastMessage()).toContain("E_LEDGER_POST");
  });
});
