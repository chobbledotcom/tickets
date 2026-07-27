import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { routePayment } from "#routes/api/webhooks.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";

/** Call the payment router and fail loudly when the request matches no route. */
export const routedResponse = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const response = await routePayment(request, url.pathname, request.method);
  assert(
    response !== null,
    `No payment route matched ${request.method} ${url.pathname}`,
  );
  return response;
};

/** Assert an HTTP status and body substring. */
export const expectResponseWithText = async (
  response: Response,
  status: number,
  text: string,
): Promise<void> => {
  expect(response.status).toBe(status);
  expect(await response.text()).toContain(text);
};

/** Assert an error response and its matching logged error. */
/** Create a listing and fill it to capacity so a subsequent booking fails. */
export const createSoldOutListing = async (
  unitPrice = 1000,
): ReturnType<typeof createTestListing> => {
  const listing = await createTestListing({ maxAttendees: 1, unitPrice });
  const { createTestAttendeeDirect } = await import(
    "#test-utils/db-helpers/attendees.ts"
  );
  await createTestAttendeeDirect(listing.id, "First", "first@example.com", 1);
  return listing;
};

/** Stub stripeApi.retrieveCheckoutSession to return a session with the given
 * id, payment intent, metadata fields, and amount. Returns the stub to
 * restore in a finally block. */
export const stubRetrieveSession = async (
  sessionId: string,
  paymentIntent: string,
  listing: { id: number },
  unitPrice: number,
  extraMeta: Record<string, string> = {},
): Promise<{ restore: () => void }> => {
  const { stubRetrieveCheckoutSession } = await import(
    "#test-utils/webhooks.ts"
  );
  return stubRetrieveCheckoutSession({
    amountTotal: unitPrice,
    metadata: signedMeta(
      {
        email: "john@example.com",
        items: singleItem(listing.id, 1, unitPrice),
        name: "John",
        ...extraMeta,
      },
      unitPrice,
    ),
    paymentIntent,
    sessionId,
  });
};
