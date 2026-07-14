import { assert, assertExists } from "@std/assert";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { attendeeAccount, WORLD } from "#shared/accounting/accounts.ts";
import { legReference } from "#shared/accounting/refs.ts";
import { postTransfers } from "#shared/accounting/store.ts";
import { decryptAttendeeFields } from "#shared/db/attendees/pii.ts";
import { getAttendeeRaw } from "#shared/db/attendees/queries.ts";
import { getCheckoutStageOrNull } from "#shared/db/checkout-stages.ts";
import { getDb } from "#shared/db/client.ts";
import { listingsTable } from "#shared/db/listings/records.ts";
import { STALE_RESERVATION_MS } from "#shared/db/processed-payments.ts";
import { assembleCheckoutMetadata } from "#shared/payment-helpers.ts";
import { stripeApi } from "#shared/stripe.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { stubRetrieveCheckoutSession } from "#test-utils/webhooks.ts";

/** Book a filler attendee so the listing's only remaining spot is consumed —
 * the state that makes a paid staged order unable to activate. */
export const fillListing = async (
  listing: Parameters<typeof bookAttendee>[0],
): Promise<void> => {
  const filler = await bookAttendee(listing, {
    email: "filler@example.com",
    name: "Filler",
  });
  assert(filler.success, "Expected filler booking");
};

/** The checkout intent a stubbed checkout captured, or a loud failure. */
export const requireIntent = <T>(
  getCaptured: () => T | null | undefined,
): T => {
  const intent = getCaptured();
  assertExists(intent, "Expected captured checkout intent");
  return intent;
};

/** Stub the provider so a refund genuinely fails: the refund call returns
 * nothing AND the payment does not read as already refunded, so `tryRefund`
 * reports false. Disposable — restore both stubs with `using`. */
export const stubFailedRefund = (): Disposable => {
  const refund = stub(stripeApi, "refundPayment", () => Promise.resolve(null));
  const status = stub(stripeApi, "retrievePaymentIntent", () =>
    Promise.resolve(null),
  );
  return {
    [Symbol.dispose]() {
      status.restore();
      refund.restore();
    },
  };
};

/** Drive the customer redirect (`/payment/success`) for a paid staged session,
 * stubbing the provider's session retrieval to return the signed metadata. */
export const paidReturn = async (
  sessionId: string,
  intent: Parameters<typeof assembleCheckoutMetadata>[1],
  total: number,
): Promise<Response> => {
  using _retrieve = stubRetrieveCheckoutSession({
    amountTotal: total,
    metadata: await assembleCheckoutMetadata("stripe", intent, total),
    paymentIntent: `pi_${sessionId}`,
    sessionId,
  });
  // `return await`, not `return`: the `using` stub is disposed when this scope
  // exits, so returning the bare promise would restore the real session
  // retrieval before the request runs and every call would 400 at classify.
  return await handleRequest(
    mockRequest(`/payment/success?session_id=${sessionId}`),
  );
};

/** Close the listing while the buyer is on the provider's page (written
 * through the table layer — closes_at is an encrypted column). */
export const closeListingMidPayment = (listingId: number) =>
  listingsTable.update(listingId, {
    closesAt: new Date(Date.now() - 60000).toISOString().slice(0, 16),
  });

/** Pre-claim the reference the session's payment leg will need, so the
 * session's money cannot be written to the ledger until it is repaired. */
export const blockSessionPaymentLeg = async (sessionId: string) =>
  postTransfers([
    {
      amount: 100,
      destination: attendeeAccount(999999),
      eventGroup: `blocker-${sessionId}`,
      kind: "payment",
      occurredAt: new Date().toISOString(),
      reference: await legReference(["booking", sessionId, "payment"]),
      source: WORLD,
    },
  ]);

/** Repair the collision so the session's money can be recorded on retry. */
export const unblockSessionPaymentLeg = (sessionId: string) =>
  getDb().execute("DELETE FROM transfers WHERE event_group = ?", [
    `blocker-${sessionId}`,
  ]);

/** Age the session's reservation past the stale window, the state a provider
 * redelivery finds after a failed attempt. */
export const ageReservation = (sessionId: string) =>
  getDb().execute(
    "UPDATE processed_payments SET processed_at = ? WHERE payment_session_id = ?",
    [
      new Date(Date.now() - STALE_RESERVATION_MS - 1000).toISOString(),
      sessionId,
    ],
  );

/** The ledger shows the charge we received and the refund returning it — and
 * nothing else: no sale leg, since the booking was never honoured. */
export const expectRefundRoundTripLegs = async (): Promise<void> => {
  const legs = await getDb().execute("SELECT kind FROM transfers");
  expect(legs.rows.map((row) => row.kind).toSorted()).toEqual([
    "payment",
    "refund_cash",
  ]);
};

export const stubSuccessfulRefund = (refundId: string) =>
  stub(stripeApi, "refundPayment", () =>
    Promise.resolve({ id: refundId } as unknown as Awaited<
      ReturnType<typeof stripeApi.refundPayment>
    >),
  );

export const expectStage = async (
  sessionId: string,
  state: string,
  quantity: number,
): Promise<void> => {
  const result = await getDb().execute(
    `SELECT stage.state, booking.quantity
     FROM checkout_stages AS stage
     JOIN listing_attendees AS booking
       ON booking.attendee_id = stage.attendee_id
     WHERE stage.payment_session_id = ?`,
    [sessionId],
  );
  expect(result.rows.map((row) => [row.state, row.quantity])).toEqual([
    [state, quantity],
  ]);
};

/** Assert a still-pending staged session's attendee carries no payment
 * reference — a failed money post threw before stamping one, so the Actions tab
 * has no charge to offer an in-app refund against while it stays unrecorded. */
export const expectNoStampedPayment = async (
  sessionId: string,
): Promise<void> => {
  const stage = await getCheckoutStageOrNull(sessionId);
  assertExists(stage, `Expected a pending stage for ${sessionId}`);
  const attendee = await getAttendeeRaw(stage.attendeeId);
  assertExists(attendee, `Expected the staged attendee for ${sessionId}`);
  expect(
    (await decryptAttendeeFields(attendee, await getTestPrivateKey(), true))
      .payment_id,
  ).toBe("");
};
