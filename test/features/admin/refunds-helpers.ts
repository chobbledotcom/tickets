import type { ListingInput } from "#shared/catalog-fields/fields.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import type { Attendee, Listing } from "#shared/types.ts";
import { createPaidAttendeeWithoutLedger } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { postListingSale } from "#test-utils/ledger.ts";
import { createAggregatePayment } from "#test-utils/payment-aggregate.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";

type CreateRefundableTestAttendee = (
  listingId: number,
  name: string,
  email: string,
  paymentId: string,
  pricePaid?: number,
) => Promise<Attendee>;

const attachRefundableAggregate = async (
  attendee: Attendee,
  listingId: number,
  name: string,
  email: string,
  paymentId: string,
  pricePaid: number,
): Promise<void> => {
  await createAggregatePayment({
    accountId: await hmacHash(
      JSON.stringify(["stripe", "test", "acct_admin_refunds"]),
    ),
    attendeeId: attendee.id,
    bookingIntent: {
      address: "",
      date: null,
      email,
      items: [{ e: listingId, p: pricePaid, q: 1 }],
      modifiers: [],
      name,
      phone: "",
      special_instructions: "",
    },
    charges: [{ amount: pricePaid, reference: paymentId }],
    paymentId,
  });
};

const makeRefundableTestAttendee =
  (recordLedgerSale: boolean): CreateRefundableTestAttendee =>
  async (listingId, name, email, paymentId, pricePaid = 500) => {
    const attendee = await createPaidAttendeeWithoutLedger(
      listingId,
      name,
      email,
      paymentId,
      pricePaid,
    );
    if (recordLedgerSale) {
      await postListingSale({
        attendeeId: attendee.id,
        eventId: paymentId,
        gross: pricePaid,
        listingId,
      });
    }
    await attachRefundableAggregate(
      attendee,
      listingId,
      name,
      email,
      paymentId,
      pricePaid,
    );
    return attendee;
  };

export const createRefundableTestAttendee: CreateRefundableTestAttendee =
  makeRefundableTestAttendee(true);

export const createRefundableTestAttendeeWithoutLedger: CreateRefundableTestAttendee =
  makeRefundableTestAttendee(false);

/** Seed `count` paid attendees with payment-intent ids `${piPrefix}<i>`. */
export const seedBatchAttendees = async (
  listing: { id: number },
  piPrefix: string,
  count = 32,
): Promise<void> => {
  for (let i = 0; i < count; i++) {
    await createRefundableTestAttendee(
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
  const attendee = await createRefundableTestAttendee(
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
  await recordAttendeeRefund(attendeeId, [{ sessionIds: [] }]);
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
