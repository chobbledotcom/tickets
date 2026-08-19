import { expect } from "@std/expect";
import { handleRequest } from "#routes";
import { mockRequest } from "#test-utils/mocks.ts";
import {
  latestAttendee,
  stubPaidSession,
  submitBuyerOrder,
} from "#test-utils/reservation/helpers.ts";

/** The shape every balance test asserts against — the newest booking's
 * plaintext reservation columns, as read back by `latestAttendee`. */
type BookedAttendee = Awaited<ReturnType<typeof latestAttendee>>;

/** Pay for a reservation through the real checkout-success route, then hand
 * back the booking it made so the test can check the exact prices.
 *
 * It stubs a signed paid Stripe session from `metadata` + `amountPaid`, drives
 * `/payment/success`, checks the request landed on a success or redirect, and
 * returns the newest attendee — always restoring the Stripe stub afterwards.
 * The caller keeps its own balance assertions. */
export const bookPaidReservation = async (
  sessionId: string,
  metadata: Record<string, string>,
  amountPaid: number,
): Promise<BookedAttendee> => {
  const session = stubPaidSession(sessionId, metadata, amountPaid);
  try {
    const response = await handleRequest(
      mockRequest(`/payment/success?session_id=${sessionId}`),
    );
    expect([200, 302, 303]).toContain(response.status);
    return await latestAttendee();
  } finally {
    session.restore();
  }
};

/** Place a plain buyer order that completes without a payment provider, then
 * hand back the booking it made so the test can check the exact prices.
 *
 * It submits the order, checks it redirected to the listing's thank-you page,
 * and returns the newest attendee. The caller keeps its own balance
 * assertions. */
export const bookFreeOrder = async (
  listing: { id: number; slug: string },
  fields: Record<string, string> = {},
): Promise<BookedAttendee> => {
  const response = await submitBuyerOrder(listing, fields);
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("https://example.com");
  return latestAttendee();
};
