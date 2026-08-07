import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { processPaymentSession } from "#routes/api/payment-processing/index.ts";
import { getAttendeeBalanceState } from "#shared/db/attendees/balance.ts";
import { execute } from "#shared/db/client.ts";
import { createReservedAttendee } from "#test-utils/balance.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  expectSessionFailed,
  getProcessedPayment,
} from "#test-utils/processed-payments.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { stubRefundPayment } from "#test-utils/webhooks.ts";
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
    using refund = stubRefundPayment("re_balance_mismatch");

    expect(await processPaymentSession(id, data)).toMatchObject({
      detail: "Provider charged 900 but signed total was 1000",
      refunded: true,
      status: 409,
      success: false,
    });
    expect((await getAttendeeBalanceState(attendeeId))?.remainingBalance).toBe(
      1000,
    );
    expect(refund.calls[0]?.args).toEqual([`pi_${id}`]);
    await expectSessionFailed(id);
  });
});
