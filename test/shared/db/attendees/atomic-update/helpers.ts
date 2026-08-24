import { assert, assertExists } from "@std/assert";
import { expect } from "@std/expect";
import type { UpdateAttendeePIIInput } from "#db/attendee-types.ts";
import {
  type applyAttendeeAtomicEdit,
  loadExistingLines,
} from "#db/attendees/atomic-update.ts";
import { createAttendeeAtomicImpl as createAttendeeAtomic } from "#db/attendees/create.ts";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

type DesiredLine = Parameters<typeof applyAttendeeAtomicEdit>[2][number];
type LineOpts = {
  date?: string | null;
  durationDays?: number;
  quantity?: number;
};
export type ExistingLines = Awaited<ReturnType<typeof loadExistingLines>>;
type SuccessfulBooking = Extract<
  Awaited<ReturnType<typeof bookAttendee>>,
  { success: true }
>;
type TestAttendee = SuccessfulBooking["attendees"][number];
type TestListing = Awaited<ReturnType<typeof createTestListing>>;

interface EditFixture {
  attendee: TestAttendee;
  blob: UpdateAttendeePIIInput;
  existing: ExistingLines;
}

/** A desired line that keeps or edits an existing booking. */
export const keepLine = (
  listingId: number,
  key: string,
  opts: LineOpts = {},
): DesiredLine => ({
  date: opts.date ?? null,
  durationDays: opts.durationDays ?? 1,
  exists: true,
  key,
  listingId,
  quantity: opts.quantity ?? 1,
});

/** A desired line for a new booking. */
export const addLine = (
  listingId: number,
  opts: LineOpts = {},
): DesiredLine => ({
  date: opts.date ?? null,
  durationDays: opts.durationDays ?? 1,
  exists: false,
  key: "",
  listingId,
  quantity: opts.quantity ?? 1,
});

export const expectRejected = (
  update: Awaited<ReturnType<typeof applyAttendeeAtomicEdit>>,
  reason: string,
  listingIds?: number[],
): void => {
  expect(update.success).toBe(false);
  assert(!update.success);
  expect(update.reason).toBe(reason);
  if (listingIds !== undefined && update.reason === "capacity_exceeded") {
    expect(update.listingIds.toSorted()).toEqual(listingIds.toSorted());
  }
};

export const expectRawCounts = async (
  pairs: [TestListing, number][],
): Promise<void> => {
  for (const [listing, count] of pairs) {
    expect((await getAttendeesRaw(listing.id)).length).toBe(count);
  }
};

export const keyFor = (existing: ExistingLines, listingId: number): string => {
  const line = existing.find((item) => item.booking.listing_id === listingId);
  assertExists(line);
  return line.key;
};

const testPii = (
  name: string,
  email: string,
  ticketToken: string,
  paymentId: string,
): UpdateAttendeePIIInput => ({
  address: "",
  email,
  lat: "",
  lng: "",
  name,
  payment_id: paymentId,
  phone: "",
  special_instructions: "",
  ticket_token: ticketToken,
});

export const bookForEdit = async (
  listing: { id: number },
  opts: Parameters<typeof bookAttendee>[1],
  blobName = "X",
  blobEmail = "",
): Promise<EditFixture> => {
  const result = await bookAttendee(listing, opts);
  assert(result.success, "Expected attendee setup to succeed");
  const attendee = result.attendees[0];
  assertExists(attendee);
  const existing = await loadExistingLines(attendee.id);
  const blob = testPii(
    blobName,
    blobEmail,
    attendee.ticket_token,
    attendee.payment_id,
  );
  return { attendee, blob, existing };
};

export const bookOnNewListing = async (
  listingOpts: Parameters<typeof createTestListing>[0],
  opts: Parameters<typeof bookAttendee>[1],
  blobName = "X",
  blobEmail = "",
): Promise<EditFixture & { listing: TestListing }> => {
  const listing = await createTestListing(listingOpts);
  return {
    listing,
    ...(await bookForEdit(listing, opts, blobName, blobEmail)),
  };
};

export const twoListings = async (
  caps: [number, number] = [10, 10],
): Promise<{ listing1: TestListing; listing2: TestListing }> => ({
  listing1: await createTestListing({ maxAttendees: caps[0], name: "E1" }),
  listing2: await createTestListing({ maxAttendees: caps[1], name: "E2" }),
});

export const setupMulti = async (
  bookings: Parameters<typeof createAttendeeAtomic>[0]["bookings"],
  createPii: { name: string; email?: string },
  blobPii: { name: string; email?: string } = createPii,
): Promise<EditFixture> => {
  const result = await createAttendeeAtomic({
    bookings,
    email: createPii.email ?? "",
    name: createPii.name,
  });
  assert(result.success, "Expected attendee setup to succeed");
  const attendee = result.attendees[0];
  assertExists(attendee);
  const existing = await loadExistingLines(attendee.id);
  const blob = testPii(
    blobPii.name,
    blobPii.email ?? "",
    attendee.ticket_token,
    attendee.payment_id,
  );
  return { attendee, blob, existing };
};
