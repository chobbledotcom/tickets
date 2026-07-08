import { expect } from "@std/expect";
import type { ListingInput } from "#shared/db/listings.ts";
import type { Attendee, Listing } from "#shared/types.ts";
import {
  createPaidTestAttendee,
  createTestListing,
  expectFlash,
  expectFlashRedirect,
  testCookie,
  testCsrfToken,
} from "#test-utils";

/** Seed `count` paid attendees with payment-intent ids `${piPrefix}<i>`. */
export const seedBatchAttendees = async (
  listing: { id: number },
  piPrefix: string,
  count = 32,
): Promise<void> => {
  for (let i = 0; i < count; i++) {
    await createPaidTestAttendee(
      listing.id,
      `User ${i}`,
      `user${i}@example.com`,
      `${piPrefix}${i}`,
    );
  }
};

/** Assert a refund-all response reporting 1 succeeded + 1 failed. */
export const expectPartialRefund = async (
  listing: { id: number },
  response: Response,
): Promise<void> => {
  await expectFlashRedirect(
    `/admin/listing/${listing.id}/refund-all`,
    expect.stringContaining("1 refund(s) succeeded"),
    false,
  )(response);
  expectFlash(response, expect.stringContaining("1 failed"), false);
};

export const createPaidListing = (
  overrides: Partial<Omit<ListingInput, "slug" | "slugIndex">> = {},
) => createTestListing({ maxAttendees: 100, unitPrice: 500, ...overrides });

export type RefundCtx = {
  listing: Listing;
  attendee: Attendee;
  cookie: string;
  csrfToken: string;
};

/** Create a paid listing + paid John Doe attendee + admin session. */
export const setupRefundTest = async (
  paymentId: string,
): Promise<RefundCtx> => {
  const listing = await createPaidListing();
  const attendee = await createPaidTestAttendee(
    listing.id,
    "John Doe",
    "john@example.com",
    paymentId,
  );
  return {
    attendee,
    cookie: await testCookie(),
    csrfToken: await testCsrfToken(),
    listing,
  };
};

/** Mark a paid test attendee as refunded through the production ledger path. */
export const markAsRefunded = async (attendeeId: number): Promise<void> => {
  const { recordAttendeeRefund } = await import("#shared/refund-ledger.ts");
  await recordAttendeeRefund(attendeeId);
};
