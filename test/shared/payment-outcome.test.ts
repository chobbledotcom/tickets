import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { bookingEventGroup } from "#shared/accounting/mappers.ts";
import { postTransfers } from "#shared/accounting/store.ts";
import { balanceEventGroup } from "#shared/db/attendees/balance.ts";
import {
  markSessionFailed,
  reserveSession,
} from "#shared/db/processed-payments.ts";
import { hasTerminalPaymentOutcome } from "#shared/payment-outcome.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { tx } from "#test-utils/ledger.ts";
import { finalizeProcessedPayment } from "#test-utils/processed-payments.ts";

describeWithEnv("terminal payment outcomes", { db: true }, () => {
  test("returns false when no local outcome exists", async () => {
    expect(await hasTerminalPaymentOutcome("outcome-missing")).toBe(false);
  });

  test("returns false for an unresolved reservation", async () => {
    await reserveSession("outcome-reserved");
    expect(await hasTerminalPaymentOutcome("outcome-reserved")).toBe(false);
  });

  test("finds a stored terminal failure", async () => {
    await reserveSession("outcome-failed");
    await markSessionFailed("outcome-failed", { error: "Stored failure" });
    expect(await hasTerminalPaymentOutcome("outcome-failed")).toBe(true);
  });

  test("finds a stored terminal success", async () => {
    await finalizeProcessedPayment("outcome-succeeded", 42);
    expect(await hasTerminalPaymentOutcome("outcome-succeeded")).toBe(true);
  });

  for (const [kind, group] of [
    ["booking", bookingEventGroup],
    ["balance", balanceEventGroup],
  ] as const) {
    test(`finds a durable ${kind} outcome after local replay data is gone`, async () => {
      await postTransfers([
        tx({
          eventGroup: await group(`outcome-${kind}`),
          reference: `outcome-${kind}-reference`,
        }),
      ]);
      expect(await hasTerminalPaymentOutcome(`outcome-${kind}`)).toBe(true);
    });
  }
});
