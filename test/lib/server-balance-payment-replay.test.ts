import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { getAttendeeBalanceState } from "#shared/db/attendees/balance.ts";
import { execute } from "#shared/db/client.ts";
import { isSessionProcessed } from "#shared/db/processed-payments.ts";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import {
  describeWithEnv,
  expectHtmlResponse,
  mockRequest,
  setupStripe,
  signedMeta,
  singleItem,
} from "#test-utils";
import { createReservedAttendee } from "#test-utils/balance.ts";

const balanceSession = (
  sessionId: string,
  attendeeId: number,
  listingId: number,
  amount: number,
) => ({
  amount_total: amount,
  created: 1_782_000_000,
  id: sessionId,
  metadata: signedMeta(
    {
      balance_attendee_id: String(attendeeId),
      email: "guest@example.com",
      items: singleItem(listingId, 1, amount),
      name: "Guest",
    },
    amount,
  ),
  payment_intent: `pi_${sessionId}`,
  payment_status: "paid",
});

describeWithEnv("server (balance payment replay)", { db: true }, () => {
  afterEach(() => {
    resetStripeClient();
  });

  test("replays a ledgered balance payment when the idempotency row is gone", async () => {
    await setupStripe();
    const { attendeeId, listingId } = await createReservedAttendee(1500);
    const sessionId = "cs_balance_replay_lost_row";
    const session = balanceSession(sessionId, attendeeId, listingId, 1500);
    const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
      Promise.resolve(
        session as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >,
      ),
    );
    const mockRefund = stub(stripeApi, "refundPayment", () =>
      Promise.resolve({ id: "re_should_not_happen" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >),
    );

    try {
      const first = await handleRequest(
        mockRequest(`/payment/success?session_id=${sessionId}`),
      );
      await expectHtmlResponse(first, 200, 'data-payment-result="success"');
      expect(
        (await getAttendeeBalanceState(attendeeId))?.remainingBalance,
      ).toBe(0);

      await execute(
        "DELETE FROM processed_payments WHERE payment_session_id = ?",
        [sessionId],
      );
      expect(await isSessionProcessed(sessionId)).toBe(null);

      const replay = await handleRequest(
        mockRequest(`/payment/success?session_id=${sessionId}`),
      );
      await expectHtmlResponse(replay, 200, 'data-payment-result="success"');
      expect((await isSessionProcessed(sessionId))?.attendee_id).toBe(
        attendeeId,
      );
      expect(mockRefund.calls.length).toBe(0);
    } finally {
      mockRefund.restore();
      mockRetrieve.restore();
    }
  });
});
