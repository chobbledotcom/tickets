import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  type BookingCompletionActions,
  bookingCompletionActions,
  completePaidBooking,
} from "#routes/api/payment-processing/completion-booking.ts";
import type { PaymentWork } from "#routes/api/webhook-types.ts";
import { getDb } from "#shared/db/client.ts";
import {
  applyPaymentSessionClaimKeepingLease,
  requirePaymentSessionClaim,
} from "#shared/db/payments/claims.ts";
import {
  type BookingCompletionEffect,
  BookingCompletionEffectSchema,
  bookingCompletion,
} from "#shared/payment-completion.ts";
import { reconcilePayment } from "#shared/payment-runtime/process.ts";
import { paymentProgress } from "#shared/payment-runtime/progress.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import {
  PAYMENT_BOOKING_COMPLETION,
  PAYMENT_ID,
  PAYMENT_INTENT,
  paymentSessionInput,
  READY_RESULT,
} from "#test/shared/db/payments/fixtures.ts";
import {
  createPendingPayment,
  getStoredPayment,
} from "#test/shared/payment-runtime/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  claimPaymentReadyToFinish,
  paymentWorkForCompletion,
  reclaimPaymentWork,
} from "#test-utils/payment-completion.ts";

const paymentWork = async (): Promise<PaymentWork> => {
  const payment = await createPendingPayment();
  const processing = await claimPaymentReadyToFinish(
    PAYMENT_ID,
    READY_RESULT,
    payment,
  );
  const attached = await applyPaymentSessionClaimKeepingLease(
    processing.claim,
    paymentProgress(processing.payment, {
      attendeeId: 42,
      completion: PAYMENT_BOOKING_COMPLETION,
      completionState: "pending",
      nextReconcileAt: Date.now() + 60_000,
      state: "processing",
      ticketState: "ready",
      ticketTokens: ["ticket-one"],
    }),
  );
  return paymentWorkForCompletion(attached, READY_RESULT);
};

const balancePaymentWork = async (): Promise<PaymentWork> => {
  const intent = { ...PAYMENT_INTENT, balanceAttendeeId: 42 };
  const payment = await createPendingPayment({
    ...paymentSessionInput(),
    bookingIntent: intent,
  });
  const resolution = {
    ...READY_RESULT,
    observation: { ...READY_RESULT.observation, bookingIntent: intent },
  };
  const plan = bookingCompletion(
    intent,
    {
      flow: "balance",
      listingId: intent.items[0]!.e,
      occurredAt: READY_RESULT.observation.createdAt,
      promos: [],
    },
    [],
  );
  const claimed = await requirePaymentSessionClaim(PAYMENT_ID, 60_000);
  const processing = await applyPaymentSessionClaimKeepingLease(
    claimed,
    paymentProgress(payment, {
      nextReconcileAt: Date.now() + 60_000,
      result: resolution,
      resultState: "succeeded",
      state: "processing",
    }),
  );
  const attached = await applyPaymentSessionClaimKeepingLease(
    processing.claim,
    paymentProgress(processing.payment, {
      attendeeId: 42,
      completion: plan,
      completionState: "pending",
      nextReconcileAt: Date.now() + 60_000,
      state: "processing",
      ticketState: "consumed",
      ticketTokens: null,
    }),
  );
  return paymentWorkForCompletion(attached, resolution);
};

const completionActions = (
  run: (effect: BookingCompletionEffect) => Promise<void>,
): BookingCompletionActions => {
  const action =
    (effect: BookingCompletionEffect) => async (): Promise<boolean> => {
      await run(effect);
      return true;
    };
  return {
    answers: action("answers"),
    balance_activity: action("balance_activity"),
    external_deliveries: action("external_deliveries"),
    external_delivery_setup: action("external_delivery_setup"),
    promo_activity: action("promo_activity"),
    registration_activity: action("registration_activity"),
  };
};

describeWithEnv("durable booking completion", { db: true }, () => {
  test("rejects a payment with no booking completion", async () => {
    const work = await paymentWork();
    work.payment.completion = null;

    await expect(completePaidBooking(work)).rejects.toThrow(
      `Payment ${PAYMENT_ID} has no booking completion`,
    );
  });

  for (const crashEffect of BookingCompletionEffectSchema.options) {
    test(`resumes after ${crashEffect} returns before its state write`, async () => {
      const work = await paymentWork();
      const calls: BookingCompletionEffect[] = [];
      let crashed = false;
      const actions = completionActions((effect) => {
        calls.push(effect);
        if (effect === crashEffect && !crashed) {
          crashed = true;
          return Promise.reject(new Error(`crash after ${effect}`));
        }
        return Promise.resolve();
      });

      await expect(completePaidBooking(work, actions)).rejects.toThrow(
        `crash after ${crashEffect}`,
      );
      const storedAfterCrash = await getStoredPayment();
      expect(storedAfterCrash.nextReconcileAt).not.toBeNull();
      if (storedAfterCrash.completion?.kind !== "booking") {
        throw new Error("Expected booking completion");
      }
      expect(storedAfterCrash.completion.effects[crashEffect]).toBe("pending");

      const result = await completePaidBooking(
        await reclaimPaymentWork(work),
        actions,
      );

      expect(result.attendee.id).toBe(42);
      expect(calls.filter((effect) => effect === crashEffect)).toHaveLength(2);
      for (const effect of BookingCompletionEffectSchema.options) {
        const expected = effect === crashEffect ? 2 : 1;
        expect(calls.filter((called) => called === effect)).toHaveLength(
          expected,
        );
      }
      expect((await getStoredPayment()).completionState).toBe("completed");
    });
  }

  test("lets a stale takeover repeat an accepted external delivery", async () => {
    const work = await paymentWork();
    let replacementClaim: Awaited<
      ReturnType<typeof requirePaymentSessionClaim>
    > | null = null;
    const deliveries: string[] = [];
    const actions = completionActions(async (effect) => {
      if (effect !== "external_deliveries") return;
      deliveries.push("accepted");
      if (deliveries.length === 1) {
        await getDb().execute(
          "UPDATE payment_sessions SET lease_expires_at = 0 WHERE id = ?",
          [PAYMENT_ID],
        );
        replacementClaim = await requirePaymentSessionClaim(PAYMENT_ID, 60_000);
      }
    });

    await expect(completePaidBooking(work, actions)).rejects.toThrow(
      `Lost payment session lease for ${PAYMENT_ID}`,
    );
    const payment = await getStoredPayment();
    if (replacementClaim === null)
      throw new Error("Expected replacement claim");
    await completePaidBooking(
      { ...work, claim: replacementClaim, payment },
      actions,
    );

    expect(deliveries).toEqual(["accepted", "accepted"]);
  });

  test("does not lose or duplicate balance activity after a later effect fails", async () => {
    const work = await balancePaymentWork();
    let fail = true;
    const actions: BookingCompletionActions = {
      ...bookingCompletionActions,
      external_deliveries: () => {
        if (fail) {
          fail = false;
          return Promise.reject(new Error("later delivery failed"));
        }
        return Promise.resolve(true);
      },
    };

    await expect(completePaidBooking(work, actions)).rejects.toThrow(
      "later delivery failed",
    );
    const firstCount = await getDb().execute(
      "SELECT COUNT(*) AS count FROM activity_log WHERE attendee_id = ?",
      [42],
    );
    expect(Number(firstCount.rows[0]?.count)).toBe(1);

    await completePaidBooking(await reclaimPaymentWork(work), actions);

    const finalCount = await getDb().execute(
      "SELECT COUNT(*) AS count FROM activity_log WHERE attendee_id = ?",
      [42],
    );
    expect(Number(finalCount.rows[0]?.count)).toBe(1);
    expect((await getStoredPayment()).completionState).toBe("completed");
  });

  test("finishes effects without changing a fully refunded payment back to completed", async () => {
    const work = await paymentWork();
    const refunded = await applyPaymentSessionClaimKeepingLease(
      work.claim,
      paymentProgress(work.payment, {
        nextReconcileAt: null,
        state: "fully_refunded",
      }),
    );
    expect(refunded.payment.nextReconcileAt).not.toBeNull();

    await completePaidBooking(
      paymentWorkForCompletion(refunded, READY_RESULT),
      completionActions(() => Promise.resolve()),
    );

    const stored = await getStoredPayment();
    expect(stored.state).toBe("fully_refunded");
    expect(stored.completionState).toBe("completed");
    expect(stored.nextReconcileAt).toBeNull();
  });

  test("replays acknowledged core while failed completion remains due", async () => {
    const work = await paymentWork();
    const effects: BookingCompletionEffect[] = [];
    let failAnswers = true;
    const actions = completionActions((effect) => {
      effects.push(effect);
      if (effect === "answers" && failAnswers) {
        failAnswers = false;
        return Promise.reject(new Error("deferred answers failed"));
      }
      return Promise.resolve();
    });
    const acknowledged = await completePaidBooking(work, actions, "critical");
    const expected = {
      attendee: { id: 42 },
      listingId: PAYMENT_INTENT.items[0]!.e,
      success: true as const,
      ticketTokens: ["ticket-one"],
    };
    expect(acknowledged).toEqual(expected);
    expect(effects).toEqual([]);
    expect((await getStoredPayment()).completionState).toBe("pending");
    using provider = stub(stripePaymentProvider, "readPayment", () => {
      throw new Error("Completion replay must not read the provider");
    });
    const fulfil = (current: PaymentWork) =>
      completePaidBooking(current, actions);

    const replay = await reconcilePayment(
      "stripe",
      { id: PAYMENT_ID, kind: "local" },
      fulfil,
    );
    expect(replay).toMatchObject({ result: expected, status: "fulfilled" });
    expect(effects).toEqual([]);

    await expect(
      reconcilePayment(
        "stripe",
        { id: PAYMENT_ID, kind: "local" },
        fulfil,
        "maintenance",
      ),
    ).rejects.toThrow("deferred answers failed");
    expect((await getStoredPayment()).completionState).toBe("pending");
    const replayAfterFailure = await reconcilePayment(
      "stripe",
      { id: PAYMENT_ID, kind: "local" },
      fulfil,
    );
    expect(replayAfterFailure).toMatchObject({
      result: expected,
      status: "fulfilled",
    });

    await reconcilePayment(
      "stripe",
      { id: PAYMENT_ID, kind: "local" },
      fulfil,
      "maintenance",
    );

    expect((await getStoredPayment()).completionState).toBe("completed");
    expect(provider.calls).toHaveLength(0);
    expect(effects.filter((effect) => effect === "answers")).toHaveLength(2);
  });

  test("terminal replay calls neither the provider nor completion effects", async () => {
    const work = await paymentWork();
    const effects: BookingCompletionEffect[] = [];
    await completePaidBooking(
      work,
      completionActions((effect) => {
        effects.push(effect);
        return Promise.resolve();
      }),
    );
    using provider = stub(stripePaymentProvider, "readPayment", () => {
      throw new Error("Terminal replay must not read the provider");
    });
    let fulfilCalls = 0;

    const outcome = await reconcilePayment(
      "stripe",
      { id: PAYMENT_ID, kind: "local" },
      () => {
        fulfilCalls += 1;
        throw new Error("Terminal replay must not run effects");
      },
    );

    expect(outcome.status).toBe("completed");
    expect(provider.calls).toHaveLength(0);
    expect(fulfilCalls).toBe(0);
    expect(effects).toEqual(BookingCompletionEffectSchema.options);
  });
});
