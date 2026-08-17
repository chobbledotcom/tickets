import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { processPaymentSession } from "#routes/api/payment-processing/index.ts";
import { getAttendeeBalanceState } from "#shared/db/attendees/balance.ts";
import { execute } from "#shared/db/client.ts";
import { createReservedAttendee } from "#test-utils/balance.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withSessionFailureFault } from "#test-utils/db-fault.ts";
import { expectLegalJointStates } from "#test-utils/joint-state.ts";
import {
  expectSessionFailed,
  getProcessedPayment,
} from "#test-utils/processed-payments.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { stripeRefundRequestShape } from "#test-utils/stripe/fixtures.ts";
import { stubRefundPayment } from "#test-utils/webhooks/stripe.ts";
import { bookingIntent, trustedPayment } from "./helpers.ts";

const balanceData = (
  id: string,
  attendeeId: number,
  listingId: number,
  amount: number,
) =>
  trustedPayment(
    id,
    bookingIntent([{ e: listingId, p: amount, q: 1 }], {
      balanceAttendeeId: attendeeId,
    }),
    amount,
  );

describeWithEnv("payment processing balance outcomes", { db: true }, () => {
  test("settles the exact balance and finalizes the payment", async () => {
    const { attendeeId, listingId } = await createReservedAttendee(1500);
    const id = "cs_direct_balance";

    expect(
      await processPaymentSession(
        id,
        balanceData(id, attendeeId, listingId, 1500),
      ),
    ).toEqual({
      attendee: { id: attendeeId },
      listingId,
      success: true,
      ticketTokens: [],
    });
    expect((await getAttendeeBalanceState(attendeeId))?.remainingBalance).toBe(
      0,
    );
    expect((await getProcessedPayment(id))?.attendee_id).toBe(attendeeId);
  });

  test("replays a ledgered balance after its reservation row is lost", async () => {
    await setupStripe();
    const { attendeeId, listingId } = await createReservedAttendee(1200);
    const id = "cs_direct_balance_replay";
    const data = balanceData(id, attendeeId, listingId, 1200);
    await processPaymentSession(id, data);
    await execute(
      "DELETE FROM processed_payments WHERE payment_session_id = ?",
      [id],
    );
    using refund = stubRefundPayment("re_should_not_run");

    expect(await processPaymentSession(id, data)).toEqual({
      attendee: { id: attendeeId },
      listingId,
      success: true,
      ticketTokens: [],
    });
    expect((await getProcessedPayment(id))?.attendee_id).toBe(attendeeId);
    expect((await getAttendeeBalanceState(attendeeId))?.remainingBalance).toBe(
      0,
    );
    expect(refund.calls).toHaveLength(0);
  });

  test("refunds a charge that does not match the signed balance", async () => {
    await setupStripe();
    const { attendeeId, listingId } = await createReservedAttendee(1000);
    const id = "cs_direct_balance_mismatch";
    const data = balanceData(id, attendeeId, listingId, 1000);
    data.session.amountTotal = 900;
    data.verdict = { agreed: 1000, verdict: "mismatch" };
    using refund = stubRefundPayment("re_balance_mismatch", 900);

    expect(await processPaymentSession(id, data)).toMatchObject({
      detail: "Provider charged 900 but signed total was 1000",
      refunded: true,
      status: 409,
      success: false,
    });
    expect((await getAttendeeBalanceState(attendeeId))?.remainingBalance).toBe(
      1000,
    );
    expect(refund.calls[0]?.args).toEqual([
      stripeRefundRequestShape(`pi_${id}`, 900),
    ]);
    await expectSessionFailed(id);
  });

  test("finishes the balance-changed answer after a crash swallowed it", async () => {
    await setupStripe();
    const { attendeeId, listingId } = await createReservedAttendee(1500);
    const id = "cs_direct_balance_crash";
    // Signed for a balance the owner has since changed, so the settle refuses
    // and the money must go back.
    const data = balanceData(id, attendeeId, listingId, 900);
    using refund = stubRefundPayment("re_balance_crash", 900);

    // First delivery: the refund goes out, then the answer's write dies.
    await expect(
      withSessionFailureFault(() => processPaymentSession(id, data)),
    ).rejects.toThrow("session failure write refused");
    expect(refund.calls).toHaveLength(1);
    await expectLegalJointStates(id, "after a crashed balance refund");

    // While the reservation is fresh, the crash looks like live work.
    expect(await processPaymentSession(id, data)).toMatchObject({
      error: "Payment is being processed. Please wait a moment and refresh.",
      success: false,
    });

    // Gone stale, the redelivery reclaims the row and finishes the tail. The
    // durable authority answers from its completed row, so nothing is sent
    // to the provider twice.
    await execute(
      "UPDATE processed_payments SET processed_at = ? WHERE payment_session_id = ?",
      ["2020-01-01T00:00:00.000Z", id],
    );
    expect(await processPaymentSession(id, data)).toMatchObject({
      error:
        "The outstanding balance for this booking changed while you were paying.",
      refunded: true,
      status: 409,
      success: false,
    });
    expect(refund.calls).toHaveLength(1);
    expect((await getAttendeeBalanceState(attendeeId))?.remainingBalance).toBe(
      1500,
    );
    await expectSessionFailed(id);

    // A later delivery replays the stored answer with no new work.
    expect(await processPaymentSession(id, data)).toMatchObject({
      refunded: true,
      success: false,
    });
    expect(refund.calls).toHaveLength(1);
  });
});
