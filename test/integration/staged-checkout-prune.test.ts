import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { selectDueCheckoutStages } from "#shared/db/checkout-stage-recovery.ts";
import { nowMs } from "#shared/now.ts";
import {
  closeAndPurgeCheckoutStage,
  closeAndPurgeCheckoutStageBySession,
} from "#shared/staged-checkout.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { sumupPaymentProvider } from "#shared/sumup-provider.ts";
import {
  attendeeExists,
  insertOrphanAttendee,
  insertUnfinalizedPayment,
} from "#test/shared/db/prune/helpers.ts";
import { insertCheckoutStage } from "#test-utils/checkout-stages.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const oldStage = (): string =>
  new Date(nowMs() - 3 * 24 * 60 * 60 * 1000).toISOString();

const addStage = async (
  sessionId: string,
  options: Parameters<typeof insertCheckoutStage>[2] = {},
): Promise<number> => {
  const attendeeId = await insertOrphanAttendee(
    new Date(nowMs()).toISOString(),
  );
  await insertCheckoutStage(attendeeId, sessionId, {
    createdAt: oldStage(),
    ...options,
  });
  return attendeeId;
};

const dueStage = async (sessionId: string) =>
  (await selectDueCheckoutStages()).find(
    (stage) => stage.paymentSessionId === sessionId,
  )!;

describeWithEnv("db > checkout stage closing", { db: true }, () => {
  test("closes and purges an unclaimed pending stage", async () => {
    const attendeeId = await addStage("close-pending", {
      providerCheckoutId: "provider-close-pending",
    });
    using close = stub(stripePaymentProvider, "closeCheckout", () =>
      Promise.resolve("closed" as const),
    );

    expect(
      await closeAndPurgeCheckoutStage(
        await dueStage("close-pending"),
        stripePaymentProvider,
      ),
    ).toBe("purged");
    expect(close.calls[0]!.args[0]).toEqual({
      providerCheckoutId: "provider-close-pending",
      sessionId: "close-pending",
    });
    expect(await attendeeExists(attendeeId)).toBe(false);
  });

  test("keeps a pending stage when payment wins during provider closure", async () => {
    const attendeeId = await addStage("close-paid");
    using close = stub(stripePaymentProvider, "closeCheckout", () =>
      Promise.resolve("paid" as const),
    );

    expect(
      await closeAndPurgeCheckoutStage(
        await dueStage("close-paid"),
        stripePaymentProvider,
      ),
    ).toBe("paid");
    expect(close.calls).toHaveLength(1);
    expect(await attendeeExists(attendeeId)).toBe(true);
  });

  test("keeps a closed stage claimed while the provider call was running", async () => {
    const attendeeId = await addStage("close-claimed");
    using close = stub(stripePaymentProvider, "closeCheckout", async () => {
      await insertUnfinalizedPayment("close-claimed", oldStage());
      return "closed" as const;
    });

    expect(
      await closeAndPurgeCheckoutStage(
        await dueStage("close-claimed"),
        stripePaymentProvider,
      ),
    ).toBe("kept");
    expect(close.calls).toHaveLength(1);
    expect(await attendeeExists(attendeeId)).toBe(true);
  });

  test("does not close a refunding stage", async () => {
    const attendeeId = await addStage("close-refunding", {
      state: "refunding",
    });
    using close = stub(stripePaymentProvider, "closeCheckout");

    expect(
      await closeAndPurgeCheckoutStageBySession(
        "close-refunding",
        stripePaymentProvider,
      ),
    ).toBe("kept");
    expect(close.calls).toHaveLength(0);
    expect(await attendeeExists(attendeeId)).toBe(true);
  });

  test("rejects a mismatched provider without deleting the stage", async () => {
    const attendeeId = await addStage("close-provider-mismatch");
    using close = stub(sumupPaymentProvider, "closeCheckout");

    await expect(
      closeAndPurgeCheckoutStageBySession(
        "close-provider-mismatch",
        sumupPaymentProvider,
      ),
    ).rejects.toThrow("provider did not match");
    expect(close.calls).toHaveLength(0);
    expect(await attendeeExists(attendeeId)).toBe(true);
  });
});
