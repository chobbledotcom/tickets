export interface ListingVisibility {
  active: boolean;
  hidden: boolean;
}

/** A listing that can be named and linked from public discovery surfaces. */
export const isPublicListing = (listing: ListingVisibility): boolean =>
  listing.active && !listing.hidden;
