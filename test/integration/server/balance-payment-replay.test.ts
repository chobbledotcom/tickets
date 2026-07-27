import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { getAttendeeBalanceState } from "#shared/db/attendees/balance.ts";
import { expectHtmlResponse } from "#test-utils/assertions.ts";
import { createReservedAttendee } from "#test-utils/balance.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import { settleDeferredPaymentWork } from "#test-utils/maintenance.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import {
  refundReferencesForAttendee,
  requirePaymentAggregateByProviderSession,
} from "#test-utils/payment-aggregate.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  stubRefundPayment,
  stubRetrieveCheckoutSession,
} from "#test-utils/webhooks.ts";

/** Stand in for the two reads a paid balance checkout needs. */
const stubBalanceSession = (
  sessionId: string,
  attendeeId: number,
  listingId: number,
  amount: number,
) =>
  stubRetrieveCheckoutSession({
    amountTotal: amount,
    created: 1_782_000_000,
    metadata: signedMeta(
      {
        balance_attendee_id: String(attendeeId),
        email: "guest@example.com",
        items: singleItem(listingId, 1, amount),
        name: "Guest",
      },
      amount,
    ),
    paymentIntent: `pi_${sessionId}`,
    sessionId,
  });

describeWithEnv("server (balance payment replay)", { db: true }, () => {
  test("replays a completed balance payment from its aggregate", async () => {
    await setupStripe();
    const { attendeeId, listingId } = await createReservedAttendee(1500);
    const sessionId = "cs_balance_replay_lost_row";
    const mockRetrieve = stubBalanceSession(
      sessionId,
      attendeeId,
      listingId,
      1500,
    );
    const mockRefund = stubRefundPayment("re_should_not_happen", 1500);
    try {
      const first = await handleRequest(
        mockRequest(`/payment/success?session_id=${sessionId}`),
      );
      await expectHtmlResponse(first, 200, 'data-payment-result="success"');
      expect(
        (await getAttendeeBalanceState(attendeeId))?.remainingBalance,
      ).toBe(0);

      // The rest of the payment's work happens a moment later, as it does on
      // the site.
      await settleDeferredPaymentWork();
      const completed =
        await requirePaymentAggregateByProviderSession(sessionId);
      expect(completed.attendeeId).toBe(attendeeId);
      expect(completed.state).toBe("completed");

      const replay = await handleRequest(
        mockRequest(`/payment/success?session_id=${sessionId}`),
      );
      await expectHtmlResponse(replay, 200, 'data-payment-result="success"');
      expect(
        (await requirePaymentAggregateByProviderSession(sessionId)).attendeeId,
      ).toBe(attendeeId);
      expect(mockRefund.calls.length).toBe(0);

      const references = await refundReferencesForAttendee(attendeeId);
      expect(references.map((reference) => reference.reference)).toContain(
        `pi_${sessionId}`,
      );
    } finally {
      mockRetrieve.restore();
      mockRefund.restore();
    }
  });
});
