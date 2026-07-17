// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { getDb } from "#shared/db/client.ts";
import type { ValidatedPaymentSession } from "#shared/payments.ts";
import { resetStripeClient } from "#shared/stripe.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { johnCheckoutSession } from "#test-utils/checkout.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import { mockRequest, withMocks } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { stagePaymentCallback } from "#test-utils/staged-payments.ts";

// jscpd:ignore-end

const stagedRace = async (sessionId: string) => {
  const listing = await createTestListing({
    maxAttendees: 50,
    unitPrice: 1000,
  });
  const items = singleItem(listing.id, 1, 1000);
  const metadata = signedMeta(
    { email: "john@example.com", items, name: "John" },
    1000,
  );
  const paymentReference = `pi_${sessionId}`;
  await stagePaymentCallback({
    amountTotal: 1000,
    metadata,
    paymentReference,
    sessionId,
  });
  const stage = await getDb().execute({
    args: [sessionId],
    sql: "SELECT attendee_id FROM checkout_stages WHERE payment_session_id = ?",
  });
  return {
    attendeeId: Number(stage.rows[0]!.attendee_id),
    items,
    listing,
    metadata,
    paymentReference,
    sessionId,
  };
};

type StagedRace = Awaited<ReturnType<typeof stagedRace>>;

const raceSession = (
  race: StagedRace,
  paymentStatus: "failed" | "paid" | "unpaid",
  authoritative: boolean,
): ValidatedPaymentSession => ({
  amountTotal: authoritative ? 1000 : 0,
  id: race.sessionId,
  metadata: race.metadata,
  paymentReference: authoritative ? race.paymentReference : "",
  paymentStatus,
});

const paidCloseMocks = (
  race: StagedRace,
  initialStatus: "failed" | "unpaid",
  refreshedStatus: "missing" | "paid" | "unpaid" = "paid",
) => {
  let reads = 0;
  return {
    close: stub(stripePaymentProvider, "closeCheckout", () =>
      Promise.resolve("paid" as const),
    ),
    retrieve: stub(stripePaymentProvider, "retrieveSession", () => {
      const first = reads++ === 0;
      if (first)
        return Promise.resolve(raceSession(race, initialStatus, false));
      return refreshedStatus === "missing"
        ? Promise.resolve(null)
        : Promise.resolve(raceSession(race, refreshedStatus, true));
    }),
  };
};

const expectExactActivation = async (race: StagedRace): Promise<void> => {
  const attendees = await getAttendeesRaw(race.listing.id);
  expect(attendees.map(({ id, quantity }) => ({ id, quantity }))).toEqual([
    { id: race.attendeeId, quantity: 1 },
  ]);
};

const expectPendingStage = async (race: StagedRace): Promise<void> => {
  expect(await getAttendeesRaw(race.listing.id)).toEqual([]);
  const stage = await getDb().execute({
    args: [race.sessionId],
    sql: "SELECT state FROM checkout_stages WHERE payment_session_id = ?",
  });
  expect(stage.rows).toEqual([{ state: "pending" }]);
};

describeWithEnv(
  "server payment cancel races",
  { db: true, triggers: true },
  () => {
    test("a paid cancel callback completes the staged booking once", async () => {
      await setupStripe();
      const { items, listing, sessionId } = await stagedRace(
        "cs_paid_cancel_race",
      );

      await withMocks(
        () => ({
          close: stub(stripePaymentProvider, "closeCheckout"),
          retrieve: johnCheckoutSession(sessionId, {
            amountTotal: 1000,
            items,
            paymentIntent: "pi_paid_cancel_race",
          }),
        }),
        async ({ close }) => {
          const first = await handleRequest(
            mockRequest(`/payment/cancel?session_id=${sessionId}`),
          );
          expect(first.status).toBe(302);
          expect(first.headers.get("location")).toContain(
            "/payment/success?tokens=",
          );
          expect(close.calls.length).toBe(0);
          expect(
            (await getAttendeesRaw(listing.id)).map((row) => row.quantity),
          ).toEqual([1]);

          const replay = await handleRequest(
            mockRequest(`/payment/cancel?session_id=${sessionId}`),
          );
          expect(replay.status).toBe(200);
          expect(await getAttendeesRaw(listing.id)).toHaveLength(1);
        },
        resetStripeClient,
      );
    });

    test("a checkout paid while cancellation closes activates its exact staged attendee once", async () => {
      await setupStripe();
      const race = await stagedRace("cs_paid_during_cancel");

      await withMocks(
        () => paidCloseMocks(race, "unpaid"),
        async ({ close, retrieve }) => {
          const response = await handleRequest(
            mockRequest(`/payment/cancel?session_id=${race.sessionId}`),
          );
          expect(response.status).toBe(302);
          expect(response.headers.get("location")).toContain(
            "/payment/success?tokens=",
          );
          expect(close.calls.length).toBe(1);
          expect(retrieve.calls.length).toBe(2);
          await expectExactActivation(race);
        },
        resetStripeClient,
      );
    });

    test("a checkout paid while a failed success callback closes completes normally", async () => {
      await setupStripe();
      const race = await stagedRace("cs_paid_during_failed_callback");

      await withMocks(
        () => paidCloseMocks(race, "failed"),
        async ({ retrieve }) => {
          const response = await handleRequest(
            mockRequest(`/payment/success?session_id=${race.sessionId}`),
          );
          expect(response.status).toBe(302);
          expect(retrieve.calls.length).toBe(2);
          await expectExactActivation(race);
        },
        resetStripeClient,
      );
    });

    for (const refresh of ["unpaid", "missing"] as const) {
      test(`a ${refresh} refresh after a paid close does not activate the stage`, async () => {
        await setupStripe();
        const race = await stagedRace(`cs_${refresh}_after_paid_close`);

        await withMocks(
          () => paidCloseMocks(race, "unpaid", refresh),
          async ({ retrieve }) => {
            const response = await handleRequest(
              mockRequest(`/payment/cancel?session_id=${race.sessionId}`),
            );
            expect(response.status).toBe(503);
            expect(retrieve.calls.length).toBe(2);
            await expectPendingStage(race);
          },
          resetStripeClient,
        );
      });
    }
  },
);
