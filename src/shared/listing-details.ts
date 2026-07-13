/**
 * The listing fields (date, place, name) that get copied, with a `listing*`
 * prefix, onto rows that describe a booking — the calendar CSV export and the
 * wallet pass. One shared shape so the two never drift apart.
 */

/** Copy a listing's date, place, and name onto a booking-style row, giving each
 * the `listing*` prefix those rows use. */
export const listingDetails = (listing: {
  date: string;
  location: string;
  name: string;
}): { listingDate: string; listingLocation: string; listingName: string } => ({
  listingDate: listing.date,
  listingLocation: listing.location,
  listingName: listing.name,
});
