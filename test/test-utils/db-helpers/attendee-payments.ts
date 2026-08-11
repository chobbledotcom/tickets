import { beforeEach } from "@std/testing/bdd";
import type {
  CreateAttendeeResult,
  ListingBooking,
} from "#shared/db/attendee-types.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import {
  type LogisticsAssignment,
  setLogisticsAssignments,
} from "#shared/db/logistics.ts";
import type { Attendee, Listing } from "#shared/types.ts";
import type { BookAttendeeOpts } from "#test-utils/internal.ts";
import { createTestAttendee } from "./attendees.ts";
import { createTestListing } from "./listings.ts";

/**
 * The attendee a booking made, or a stop right here.
 *
 * Every fixture that books somebody needs the same narrowing, and a booking
 * that failed is a broken fixture rather than a case under test — so it says
 * so by name instead of each caller inventing its own guard or asserting the
 * shape it hopes for.
 */
export const bookedAttendee = (result: CreateAttendeeResult): Attendee => {
  if (!result.success) {
    throw new Error(`Failed to create the attendee: ${result.reason}`);
  }
  return result.attendees[0]!;
};

/**
 * Create a paid attendee (a payment_id + booking) WITHOUT posting any ledger
 * sale — a booking that predates the transfers ledger. A refund of it finds no
 * clean order to reverse, so `recordAttendeeRefund` reports `posted:false`; use
 * this to drive the "provider refunded but the ledger couldn't record it" paths.
 */
export const createPaidAttendeeWithoutLedger = async (
  listingId: number,
  name: string,
  email: string,
  paymentId: string,
  pricePaid = 500,
  quantity = 1,
): Promise<Attendee> => {
  const result = await attendeesApi.createAttendeeAtomic({
    bookings: [{ listingId, pricePaid, quantity }],
    email,
    name,
    paymentId,
  });
  return bookedAttendee(result);
};

export const createPaidTestAttendee = async (
  listingId: number,
  name: string,
  email: string,
  paymentId: string,
  pricePaid = 500,
  quantity = 1,
): Promise<Attendee> => {
  const attendee = await createPaidAttendeeWithoutLedger(
    listingId,
    name,
    email,
    paymentId,
    pricePaid,
    quantity,
  );
  // A paid attendee recognises gross revenue: post the sale leg so the
  // ledger-projected listing income reflects it (the price_paid column alone no
  // longer feeds income). A free (pricePaid 0) attendee posts nothing.
  if (pricePaid > 0) {
    const { postListingSale } = await import("#test-utils/ledger.ts");
    await postListingSale({
      attendeeId: attendee.id,
      gross: pricePaid,
      listingId,
    });
  }
  return attendee;
};

export const bookAttendee = async (
  listing: Pick<Listing, "id">,
  opts: BookAttendeeOpts = {},
): Promise<CreateAttendeeResult> => {
  const booking: ListingBooking = {
    listingId: listing.id,
  };
  if (opts.date !== undefined) booking.date = opts.date;
  if (opts.quantity !== undefined) booking.quantity = opts.quantity;
  if (opts.pricePaid !== undefined) booking.pricePaid = opts.pricePaid;
  if (opts.durationDays !== undefined) booking.durationDays = opts.durationDays;
  const result = await attendeesApi.createAttendeeAtomic({
    bookings: [booking],
    email: opts.email ?? "x@example.com",
    name: opts.name ?? "X",
    ...(opts.phone !== undefined && { phone: opts.phone }),
    ...(opts.address !== undefined && { address: opts.address }),
    ...(opts.special_instructions !== undefined && {
      special_instructions: opts.special_instructions,
    }),
    ...(opts.paymentId !== undefined && { paymentId: opts.paymentId }),
  });
  // Mirror the live paid-checkout flow: a paid booking recognises gross revenue
  // with a ledger sale leg (which the per-row amount-paid projection reads), so a
  // bare price_paid no longer means anything on its own.
  if (result.success && opts.pricePaid && opts.pricePaid > 0) {
    const { postListingSale } = await import("#test-utils/ledger.ts");
    await postListingSale({
      attendeeId: result.attendees[0]!.id,
      gross: opts.pricePaid,
      listingId: listing.id,
    });
  }
  return result;
};

/** Create a single-capacity listing and immediately book its one slot with a
 *  fixed "first@example.com" attendee — the disposable filler used by tests
 *  that then try to book (or refund) a second, over-capacity purchase. */
export const fillSoleCapacityListing = async (
  unitPrice = 1000,
): Promise<Listing> => {
  const listing = await createTestListing({ maxAttendees: 1, unitPrice });
  await bookAttendee(listing, {
    email: "first@example.com",
    name: "First",
    paymentId: "pi_first",
  });
  return listing;
};

/** Create a listing (maxAttendees 100) + attendee ("Cust" / "c@example.com")
 *  and assign logistics agents to its single booking line. The `assignments`
 *  callback receives the listing ID so the caller can key the map correctly
 *  without having to create the listing itself first. Shared by the
 *  logistics-runsheet and server-logistics test suites. */
export const createListingWithAttendeeAndLogistics = async (
  assignments: (listingId: number) => Map<number, LogisticsAssignment>,
): Promise<{ attendeeId: number; listingId: number }> => {
  const listing = await createTestListing({ maxAttendees: 100 });
  const attendee = await createTestAttendee(
    listing.id,
    listing.slug,
    "Cust",
    "c@example.com",
  );
  await setLogisticsAssignments(attendee.id, false, assignments(listing.id));
  return { attendeeId: attendee.id, listingId: listing.id };
};

/** Register the standard processed-payments attenddee fixture: one listing +
 *  one attendee ("Test User" / "test@example.com") created in `beforeEach`,
 *  returning a holder whose `.attendeeId` is the current test's attendee id.
 *  Used by the locking and staleness test suites that share this exact setup. */
export const useProcessedPaymentsAttendee = (): { attendeeId: number } => {
  const holder = { attendeeId: 0 as number };
  beforeEach(async () => {
    const listing = await createTestListing();
    const attendee = await createTestAttendee(
      listing.id,
      listing.slug,
      "Test User",
      "test@example.com",
    );
    holder.attendeeId = attendee.id;
  });
  return holder;
};
