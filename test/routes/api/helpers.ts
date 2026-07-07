import { expect } from "@std/expect";
import { beforeEach } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import * as v from "valibot";
import { handleRequest } from "#routes";
import { settings } from "#shared/db/settings.ts";
import {
  createTestListing,
  describeWithEnv,
  jsonRequest,
  PublicListingSchema,
} from "#test-utils";

/** Parse JSON response */
export const jsonBody = (
  response: Response,
): Promise<Record<string, unknown>> => response.json();

/** Shape of the public booking endpoint's JSON response (wrapped under `booking`) */
export type BookResponseBody = {
  error?: string;
  booking?: {
    ticketToken?: string;
    ticketUrl?: string;
    checkoutUrl?: string;
    amountOwed?: number;
  };
};

/** Assert CORS headers are present */
export const expectCorsHeaders = (response: Response): void => {
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
};

/** Run the shared "Public API" suite body under a db+triggers env with the
 *  public API enabled before each test. */
export const describePublicApi = (fn: () => void): void =>
  describeWithEnv("Public API", { db: true, triggers: true }, () => {
    beforeEach(async () => {
      await settings.update.showPublicApi(true);
    });
    fn();
  });

/** Fetch the listings list and return parsed listings array */
export const fetchListingsList = async (): Promise<{
  response: Response;
  listings: Record<string, unknown>[];
}> => {
  const response = await handleRequest(jsonRequest("/api/listings"));
  const body = await jsonBody(response);
  return { listings: body.listings as Record<string, unknown>[], response };
};

/** Fetch a single listing by slug and return parsed listing */
export const fetchListingBySlug = async (
  slug: string,
): Promise<{ response: Response; body: Record<string, unknown> }> => {
  const response = await handleRequest(jsonRequest(`/api/listings/${slug}`));
  const body = await jsonBody(response);
  return { body, response };
};

/** Fetch a listing by slug, assert 200, and return the response + parsed
 * public listing. */
export const fetchPublicListing = async (slug: string) => {
  const { response, body } = await fetchListingBySlug(slug);
  expect(response.status).toBe(200);
  return { apiListing: v.parse(PublicListingSchema, body.listing), response };
};

/** Book an listing by slug with given body fields */
export const bookListing = async (
  slug: string,
  bookingBody: Record<string, unknown> = {
    email: "alice@test.com",
    name: "Alice",
  },
): Promise<{ response: Response; body: BookResponseBody }> => {
  const response = await handleRequest(
    jsonRequest(`/api/listings/${slug}/book`, {
      body: bookingBody,
      method: "POST",
    }),
  );
  const body = (await jsonBody(response)) as BookResponseBody;
  return { body, response };
};

/** Book a listing by slug, assert 200 with a ticket token issued, and return
 * the booking body for further assertions. */
export const bookForToken = async (slug: string): Promise<BookResponseBody> => {
  const { response, body } = await bookListing(slug);
  expect(response.status).toBe(200);
  expect(body.booking?.ticketToken).toBeDefined();
  return body;
};

/** Assert exactly one attendee landed on `targetId` and none on `otherId`. */
export const expectBookedTo = async (
  targetId: number,
  otherId: number,
): Promise<void> => {
  const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
  expect((await getAttendeesRaw(targetId)).length).toBe(1);
  expect((await getAttendeesRaw(otherId)).length).toBe(0);
};

/** Fetch availability for an listing by slug, with optional query string */
export const fetchAvailability = async (
  slug: string,
  query = "",
): Promise<{ response: Response; body: Record<string, unknown> }> => {
  const qs = query ? `?${query}` : "";
  const response = await handleRequest(
    jsonRequest(`/api/listings/${slug}/availability${qs}`),
  );
  const body = await jsonBody(response);
  return { body, response };
};

/** Create a pay-more test listing with standard defaults */
export const createPayMoreListing = (overrides: {
  unitPrice: number;
  maxPrice: number;
  maxAttendees?: number;
}) =>
  createTestListing({
    canPayMore: true,
    maxAttendees: overrides.maxAttendees ?? 10,
    maxPrice: overrides.maxPrice,
    unitPrice: overrides.unitPrice,
  });

/** Create a raw POST request with custom content-type and body string */
export const rawPostRequest = (
  slug: string,
  contentType: string,
  rawBody: string,
): Request =>
  new Request(`http://localhost/api/listings/${slug}/book`, {
    body: rawBody,
    headers: { "content-type": contentType, host: "localhost" },
    method: "POST",
  });

/** Stub a stripe checkout method and run a test, restoring after */
export const withCheckoutStub = async (
  stubResult: import("#shared/payments.ts").CheckoutSessionResult,
  fn: () => Promise<void>,
) => {
  const { stripePaymentProvider } = await import("#shared/stripe-provider.ts");
  const mockCreate = stub(stripePaymentProvider, "createCheckoutSession", () =>
    Promise.resolve(stubResult),
  );
  try {
    await fn();
  } finally {
    mockCreate.restore();
  }
};
