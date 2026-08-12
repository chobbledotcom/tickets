import type { ListingInput } from "#shared/catalog-fields/fields.ts";
import type { Attendee, Listing } from "#shared/types.ts";
import { createPaidTestAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";

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
  const { recordAttendeeRefund } = await import(
    "#shared/refund-ledger/record.ts"
  );
  const index = `legacy-refund-${attendeeId}`;
  const result = await recordAttendeeRefund(attendeeId, [
    { index, sessionIds: [] },
  ]);
  if (!result.recorded.has(index)) {
    throw new Error(`The refund ledger did not record ${index}`);
  }
};

export const setBookingLineQuantity = async (
  attendeeId: number,
  listingId: number,
  quantity: number,
): Promise<void> => {
  const { getDb } = await import("#shared/db/client.ts");
  await getDb().execute(
    "UPDATE listing_attendees SET quantity = ? WHERE attendee_id = ? AND listing_id = ?",
    [quantity, attendeeId, listingId],
  );
};
