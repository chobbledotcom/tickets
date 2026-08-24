import { expect } from "@std/expect";
import type { ListingInput } from "#shared/catalog-fields/fields.ts";
import {
  createPaidAttendeeWithoutLedger,
  createPaidTestAttendee,
} from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  getCompleteRefundPaymentReferencesForAttendee,
  markProviderRefundsReturned,
} from "#test-utils/payment-references.ts";
import {
  finalizeProcessedPayment,
  taggedPaymentReference,
} from "#test-utils/processed-payments.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";
import type { Attendee, Listing, PaymentProviderType } from "#types";

const paymentSessionId = (listingId: number, attendeeId: number): string =>
  `sale-${listingId}-${attendeeId}`;

/** Create a paid attendee whose provider-tagged payment row names its sale. */
export const createRefundableAttendee = async (
  listingId: number,
  name: string,
  email: string,
  reference: string,
  {
    ledger = "recorded",
    pricePaid = 500,
    provider = "stripe",
    quantity = 1,
  }: {
    ledger?: "missing" | "recorded";
    pricePaid?: number;
    provider?: PaymentProviderType;
    quantity?: number;
  } = {},
): Promise<Attendee> => {
  const createPaidAttendee =
    ledger === "recorded"
      ? createPaidTestAttendee
      : createPaidAttendeeWithoutLedger;
  const attendee = await createPaidAttendee(
    listingId,
    name,
    email,
    "",
    pricePaid,
    quantity,
  );
  await finalizeProcessedPayment(
    paymentSessionId(listingId, attendee.id),
    attendee.id,
    "",
    taggedPaymentReference(reference, provider),
  );
  return attendee;
};

/** Seed modern provider-tagged payments whose ledger event names each order. */
export const seedTaggedBatchAttendees = async (
  listing: { id: number },
  referencePrefix: string,
  count: number,
): Promise<void> => {
  for (let index = 0; index < count; index++) {
    await createRefundableAttendee(
      listing.id,
      `User ${index}`,
      `user${index}@example.com`,
      `${referencePrefix}${index}`,
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
  const attendee = await createRefundableAttendee(
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
  const references = await getCompleteRefundPaymentReferencesForAttendee({
    currentPaymentId: "",
    id: attendeeId,
  });
  const result = await recordAttendeeRefund(attendeeId, references);
  expect(result.recorded).toEqual(
    new Set(references.map(({ index }) => index)),
  );
  await markProviderRefundsReturned(
    references.filter(({ refundState }) => refundState !== "completed"),
  );
};

export const setBookingLineQuantity = async (
  attendeeId: number,
  listingId: number,
  quantity: number,
): Promise<void> => {
  const { getDb } = await import("#db/client.ts");
  await getDb().execute(
    "UPDATE listing_attendees SET quantity = ? WHERE attendee_id = ? AND listing_id = ?",
    [quantity, attendeeId, listingId],
  );
};
