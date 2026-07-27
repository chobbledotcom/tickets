import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { getAttendeeBalanceState } from "#shared/db/attendees/balance.ts";
import { stripeApi } from "#shared/stripe.ts";
import { expectHtmlResponse } from "#test-utils/assertions.ts";
import { createReservedAttendee } from "#test-utils/balance.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import {
  refundReferencesForAttendee,
  requirePaymentAggregateByProviderSession,
} from "#test-utils/payment-aggregate.ts";
import { setupStripe } from "#test-utils/settings.ts";

const balanceSession = (
  sessionId: string,
  attendeeId: number,
  listingId: number,
  amount: number,
): NonNullable<
  Awaited<ReturnType<typeof stripeApi.retrieveCheckoutSession>>
> => ({
  amount_total: amount,
  created: 1_782_000_000,
  currency: "gbp",
  id: sessionId,
  livemode: false,
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
  status: "complete",
  url: null,
});

describeWithEnv("server (balance payment replay)", { db: true }, () => {
  test("replays a completed balance payment from its aggregate", async () => {
    await setupStripe();
    const { attendeeId, listingId } = await createReservedAttendee(1500);
    const sessionId = "cs_balance_replay_lost_row";
    const session = balanceSession(sessionId, attendeeId, listingId, 1500);
    using _mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
      Promise.resolve(session),
    );
    using mockRefund = stub(stripeApi, "requestRefund", () =>
      Promise.resolve({
        id: "re_should_not_happen",
        status: "succeeded",
      } as unknown as Awaited<ReturnType<typeof stripeApi.requestRefund>>),
    );

    const first = await handleRequest(
      mockRequest(`/payment/success?session_id=${sessionId}`),
    );
    await expectHtmlResponse(first, 200, 'data-payment-result="success"');
    expect((await getAttendeeBalanceState(attendeeId))?.remainingBalance).toBe(
      0,
    );

    const completed = await requirePaymentAggregateByProviderSession(sessionId);
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
  });
});
