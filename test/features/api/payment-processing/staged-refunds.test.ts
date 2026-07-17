// test-groups: run-alone
/* jscpd:ignore-start */

import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { processPaymentSession } from "#routes/api/payment-processing/index.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { loadCheckoutStageByPaymentSession } from "#shared/db/checkout-stages.ts";
import { DatabaseBusyError, getDb, queryAll } from "#shared/db/client.ts";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { createTestSystemNote } from "#test-utils/system-notes.ts";
import {
  attendeeIds,
  intentFor,
  paidSession,
  stageSession,
} from "./staged-runtime.helpers.ts";

/* jscpd:ignore-end */

describeWithEnv("payment processing > staged refunds", { db: true }, () => {
  afterEach(() => resetStripeClient());

  test("enters refunding before provider IO and atomically removes the staged attendee", async () => {
    await setupStripe();
    const listing = await createTestListing({ unitPrice: 1000 });
    const intent = intentFor(listing.id);
    const attendeeId = await stageSession("durable-refund", intent);
    await createTestSystemNote(attendeeId, "Removed with staged attendee");
    await deactivateTestListing(listing.id);
    let stateDuringRefund = "";
    const refund = stub(stripeApi, "refundPayment", async () => {
      stateDuringRefund = (await loadCheckoutStageByPaymentSession(
        "durable-refund",
      ))!.state;
      return { id: "refund-durable", status: "succeeded" } as never;
    });
    try {
      const result = await processPaymentSession(
        "durable-refund",
        paidSession("durable-refund", intent),
      );
      expect(stateDuringRefund).toBe("refunding");
      expect(result).toMatchObject({ refunded: true, success: false });
      expect(await attendeeIds()).toEqual([]);
      expect(
        await loadCheckoutStageByPaymentSession("durable-refund"),
      ).toBeNull();
      expect(
        await queryAll(
          `SELECT attendee_id, provider_refunded_at, failure_data
             FROM processed_payments WHERE payment_session_id = ?`,
          ["durable-refund"],
        ),
      ).toEqual([
        {
          attendee_id: null,
          failure_data: expect.any(String),
          provider_refunded_at: expect.any(String),
        },
      ]);
      expect(
        await queryAll(
          "SELECT attendee_id FROM system_notes WHERE attendee_id = ?",
          [attendeeId],
        ),
      ).toEqual([]);
      expect(
        await queryAll(
          `SELECT kind, source_id, dest_id FROM transfers
            WHERE source_id = ? OR dest_id = ? ORDER BY kind`,
          [String(attendeeId), String(attendeeId)],
        ),
      ).toEqual([
        { dest_id: String(attendeeId), kind: "payment", source_id: "world" },
        {
          dest_id: "world",
          kind: "refund_cash",
          source_id: String(attendeeId),
        },
      ]);
    } finally {
      refund.restore();
    }
  });

  test("leaves a failed refund retryable and never reconsiders activation", async () => {
    await setupStripe();
    const listing = await createTestListing({ unitPrice: 1000 });
    const intent = intentFor(listing.id);
    const attendeeId = await stageSession("refund-retry", intent);
    await deactivateTestListing(listing.id);
    let attempt = 0;
    const refund = stub(stripeApi, "refundPayment", () => {
      attempt += 1;
      return Promise.resolve(
        attempt === 1
          ? null
          : ({ id: "refund-retry", status: "succeeded" } as never),
      );
    });
    const status = stub(stripeApi, "retrievePaymentIntent", () =>
      Promise.resolve({ latest_charge: { refunded: false } } as never),
    );
    try {
      const first = await processPaymentSession(
        "refund-retry",
        paidSession("refund-retry", intent),
      );
      expect(first).toMatchObject({ refunded: false, status: 503 });
      expect(
        await loadCheckoutStageByPaymentSession("refund-retry"),
      ).toMatchObject({ attendeeId, state: "refunding" });
      expect(
        await queryAll(
          "SELECT payment_session_id FROM processed_payments WHERE payment_session_id = ?",
          ["refund-retry"],
        ),
      ).toEqual([]);
      await queryAll("UPDATE listings SET active = 1 WHERE id = ?", [
        listing.id,
      ]);
      const second = await processPaymentSession(
        "refund-retry",
        paidSession("refund-retry", intent),
      );
      expect(second).toMatchObject({ refunded: true, success: false });
      expect(attempt).toBe(2);
      expect(await attendeeIds()).toEqual([]);
    } finally {
      refund.restore();
      status.restore();
    }
  });

  test("replay returns the stored failure without another provider call", async () => {
    await setupStripe();
    const listing = await createTestListing({ unitPrice: 1000 });
    const intent = intentFor(listing.id);
    await stageSession("refund-replay", intent);
    await deactivateTestListing(listing.id);
    const refund = stub(stripeApi, "refundPayment", () =>
      Promise.resolve({ id: "refund-replay", status: "succeeded" } as never),
    );
    try {
      const first = await processPaymentSession(
        "refund-replay",
        paidSession("refund-replay", intent),
      );
      const replay = await processPaymentSession(
        "refund-replay",
        paidSession("refund-replay", intent),
      );
      if (first.success) throw new Error("Expected refund failure result");
      expect(replay).toEqual({
        error: first.error,
        refunded: true,
        status: first.status,
        success: false,
      });
      expect(refund.calls.length).toBe(1);
    } finally {
      refund.restore();
    }
  });

  test("finalizes on retry when the provider refunded before local finalization failed", async () => {
    await setupStripe();
    const listing = await createTestListing({ unitPrice: 1000 });
    const intent = intentFor(listing.id);
    await stageSession("refund-crash", intent);
    await deactivateTestListing(listing.id);
    let attempt = 0;
    const refund = stub(stripeApi, "refundPayment", () => {
      attempt += 1;
      return Promise.resolve(
        attempt === 1
          ? ({ id: "refund-crash", status: "succeeded" } as never)
          : null,
      );
    });
    const status = stub(stripeApi, "retrievePaymentIntent", () =>
      Promise.resolve({ latest_charge: { refunded: true } } as never),
    );
    await getDb().execute(`CREATE TRIGGER reject_local_refund_finalization
      BEFORE UPDATE OF failure_data ON processed_payments
      WHEN NEW.payment_session_id = 'refund-crash'
      BEGIN
        SELECT RAISE(ABORT, 'local finalization failed');
      END`);
    try {
      await expect(
        processPaymentSession(
          "refund-crash",
          paidSession("refund-crash", intent),
        ),
      ).rejects.toThrow("local finalization failed");
      expect(
        await loadCheckoutStageByPaymentSession("refund-crash"),
      ).toMatchObject({ state: "refunding" });
      await getDb().execute("DROP TRIGGER reject_local_refund_finalization");
      const recovered = await processPaymentSession(
        "refund-crash",
        paidSession("refund-crash", intent),
      );
      expect(recovered).toMatchObject({ refunded: true, success: false });
      expect(refund.calls.length).toBe(2);
      expect(status.calls.length).toBe(1);
      expect(await attendeeIds()).toEqual([]);
    } finally {
      await getDb().execute(
        "DROP TRIGGER IF EXISTS reject_local_refund_finalization",
      );
      refund.restore();
      status.restore();
    }
  });

  test("concurrent last-seat payments activate one stage and refund the other", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 1,
      unitPrice: 1000,
    });
    const firstIntent = intentFor(listing.id);
    const secondIntent = {
      ...intentFor(listing.id),
      email: "second-stage@example.com",
    };
    const firstId = await stageSession("last-seat-first", firstIntent);
    const secondId = await stageSession("last-seat-second", secondIntent);
    const activateStage = attendeesApi.activateStagedAttendee;
    const activated = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const pauseFirst = stub(
      attendeesApi,
      "activateStagedAttendee",
      async (...args) => {
        const result = await activateStage(...args);
        if (args[0].paymentSessionId === "last-seat-first") {
          if (!result.success) throw new Error("First stage did not activate");
          activated.resolve();
          await releaseFirst.promise;
        }
        return result;
      },
    );
    const refund = stub(stripeApi, "refundPayment", () =>
      Promise.resolve({ id: "last-seat-refund", status: "succeeded" } as never),
    );
    try {
      const firstPayment = processPaymentSession(
        "last-seat-first",
        paidSession("last-seat-first", firstIntent),
      );
      await activated.promise;
      const secondPayment = processPaymentSession(
        "last-seat-second",
        paidSession("last-seat-second", secondIntent),
      );
      const secondResult = await secondPayment;
      releaseFirst.resolve();
      const results = [await firstPayment, secondResult];
      expect(results.filter((result) => result.success)).toHaveLength(1);
      expect(
        results.filter((result) => !result.success && result.refunded),
      ).toHaveLength(1);
      const survivors = await attendeeIds();
      expect(survivors).toHaveLength(1);
      expect([firstId, secondId]).toContain(survivors[0]!.id);
      expect(survivors[0]!.id).toBe(firstId);
      expect(refund.calls.length).toBe(1);
    } finally {
      releaseFirst.resolve();
      pauseFirst.restore();
      refund.restore();
    }
  });

  test("persistent database contention does not enter the refund rail", async () => {
    await setupStripe();
    const listing = await createTestListing({ unitPrice: 1000 });
    const intent = intentFor(listing.id);
    await stageSession("busy-stage", intent);
    const refund = stub(stripeApi, "refundPayment", () =>
      Promise.resolve({
        id: "unexpected-refund",
        status: "succeeded",
      } as never),
    );
    const activate = stub(attendeesApi, "activateStagedAttendee", () =>
      Promise.reject(new DatabaseBusyError()),
    );
    try {
      await expect(
        processPaymentSession("busy-stage", paidSession("busy-stage", intent)),
      ).rejects.toThrow(DatabaseBusyError);
      expect(activate.calls.length).toBe(3);
      expect(refund.calls.length).toBe(0);
    } finally {
      activate.restore();
      refund.restore();
    }
    expect(await loadCheckoutStageByPaymentSession("busy-stage")).toMatchObject(
      { state: "pending" },
    );
  });
});
