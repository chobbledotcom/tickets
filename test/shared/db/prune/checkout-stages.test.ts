import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getDb } from "#shared/db/client.ts";
import { nowMs } from "#shared/now.ts";
import {
  closeAndPurgeCheckoutStageBySession,
  pruneAbandonedCheckoutStages,
} from "#shared/staged-checkout.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { sumupPaymentProvider } from "#shared/sumup-provider.ts";
import { insertCheckoutStage } from "#test-utils/checkout-stages.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  attendeeExists,
  insertOrphanAttendee,
  insertUnfinalizedPayment,
} from "./helpers.ts";

const oldStage = (): string =>
  new Date(nowMs() - 3 * 24 * 60 * 60 * 1000).toISOString();

const recentStage = (): string => new Date(nowMs() - 60_000).toISOString();

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

const expectStageKept = async (
  sessionId: string,
  closeCheckout: () => Promise<"closed" | "paid">,
): Promise<void> => {
  const attendeeId = await addStage(sessionId);
  const close = stub(stripePaymentProvider, "closeCheckout", closeCheckout);
  try {
    expect(await pruneAbandonedCheckoutStages()).toBe(0);
    expect(await attendeeExists(attendeeId)).toBe(true);
  } finally {
    close.restore();
  }
};

const expectStageNotSelected = async (
  sessionId: string,
  options: Parameters<typeof insertCheckoutStage>[2],
): Promise<void> => {
  const attendeeId = await addStage(sessionId, options);
  const close = stub(stripePaymentProvider, "closeCheckout");
  try {
    expect(await pruneAbandonedCheckoutStages()).toBe(0);
    expect(close.calls.length).toBe(0);
    expect(await attendeeExists(attendeeId)).toBe(true);
  } finally {
    close.restore();
  }
};

describeWithEnv("db > abandoned checkout stages", { db: true }, () => {
  describe("pruneAbandonedCheckoutStages", () => {
    test("closes and purges an old pending stage", async () => {
      const attendeeId = await addStage("old-pending", {
        providerCheckoutId: "provider-old-pending",
      });
      const close = stub(stripePaymentProvider, "closeCheckout", () =>
        Promise.resolve("closed" as const),
      );
      try {
        expect(await pruneAbandonedCheckoutStages()).toBe(1);
        expect(close.calls[0]!.args[0]).toEqual({
          providerCheckoutId: "provider-old-pending",
          sessionId: "old-pending",
        });
        expect(await attendeeExists(attendeeId)).toBe(false);
      } finally {
        close.restore();
      }
    });

    test("keeps a recent pending stage without calling its provider", async () => {
      await expectStageNotSelected("recent", { createdAt: recentStage() });
    });

    test("never closes or purges a refunding stage", async () => {
      await expectStageNotSelected("refunding", { state: "refunding" });
    });

    test("direct cleanup keeps a refunding stage without calling its provider", async () => {
      const attendeeId = await addStage("direct-refunding", {
        state: "refunding",
      });
      const close = stub(stripePaymentProvider, "closeCheckout");
      try {
        expect(
          await closeAndPurgeCheckoutStageBySession(
            "direct-refunding",
            stripePaymentProvider,
          ),
        ).toBe("kept");
        expect(close.calls.length).toBe(0);
        expect(await attendeeExists(attendeeId)).toBe(true);
      } finally {
        close.restore();
      }
    });

    test("direct cleanup rejects a mismatched provider without deleting", async () => {
      const attendeeId = await addStage("provider-mismatch");
      const close = stub(sumupPaymentProvider, "closeCheckout");
      try {
        await expect(
          closeAndPurgeCheckoutStageBySession(
            "provider-mismatch",
            sumupPaymentProvider,
          ),
        ).rejects.toThrow("provider did not match");
        expect(close.calls.length).toBe(0);
        expect(await attendeeExists(attendeeId)).toBe(true);
      } finally {
        close.restore();
      }
    });

    test("keeps a stage when payment already won", async () => {
      await expectStageKept("paid", () => Promise.resolve("paid"));
    });

    test("keeps a stage when the provider close fails", async () => {
      await expectStageKept("provider-error", () =>
        Promise.reject(new Error("provider unavailable")),
      );
    });

    test("keeps a closed stage claimed while the provider call was running", async () => {
      await expectStageKept("claimed", async () => {
        await insertUnfinalizedPayment("claimed", oldStage());
        return "closed" as const;
      });
    });

    test("processes exactly the fixed cleanup bound", async () => {
      const cleanupLimit = 4;
      const createdAt = oldStage();
      const ids = await Promise.all(
        Array.from({ length: cleanupLimit + 1 }, (_, index) =>
          addStage(`bounded-${index}`, { createdAt }),
        ),
      );
      const close = stub(stripePaymentProvider, "closeCheckout", () =>
        Promise.resolve("closed" as const),
      );
      try {
        expect(await pruneAbandonedCheckoutStages()).toBe(cleanupLimit);
        expect(close.calls.length).toBe(cleanupLimit);
        const remaining = await getDb().execute(
          "SELECT attendee_id FROM checkout_stages",
        );
        expect(remaining.rows.map((row) => Number(row.attendee_id))).toEqual([
          ids.at(-1),
        ]);
      } finally {
        close.restore();
      }
    });
  });
});
