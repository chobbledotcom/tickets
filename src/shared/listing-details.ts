/**
 * The listing fields (date, place, name) that get copied, with a `listing*`
 * prefix, onto rows that describe a booking. The calendar CSV export and the
 * wallet pass both use it. One shared shape so the two never drift apart.
 */

/** Copy a listing's date, place, and name onto a booking-style row. Each
 * field gets the `listing*` prefix those rows use. */
export const listingDetails = (listing: {
  date: string;
  location: string;
  name: string;
}): { listingDate: string; listingLocation: string; listingName: string } => ({
  listingDate: listing.date,
  listingLocation: listing.location,
  listingName: listing.name,
});
