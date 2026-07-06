import { createTestAttendee, createTestListing } from "#test-utils/db-helpers.ts";

type ListingOverrides = Parameters<typeof createTestListing>[0];

/**
 * Creates a listing and books one attendee onto it — the setup almost every
 * admin-attendee test starts from. Defaults to a 100-seat listing and a "John
 * Doe" attendee; pass overrides for a different listing or a different person.
 */
export const seedListingAttendee = async (
  overrides: ListingOverrides = { maxAttendees: 100 },
  name = "John Doe",
  email = "john@example.com",
) => {
  const listing = await createTestListing(overrides);
  const attendee = await createTestAttendee(
    listing.id,
    listing.slug,
    name,
    email,
  );
  return { attendee, listing };
};

/**
 * Removes every booking for an attendee so it no longer has a home listing —
 * the "orphaned attendee" state the attendee-scoped routes 404 on.
 */
export const orphanAttendee = async (attendeeId: number) => {
  const { getDb } = await import("#shared/db/client.ts");
  await getDb().execute(
    "DELETE FROM listing_attendees WHERE attendee_id = ?",
    [attendeeId],
  );
};
