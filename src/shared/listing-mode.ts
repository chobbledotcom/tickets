/** How the public listings page presents each listing: the classic text
 *  cards, or the product-card gallery. */
export type ListingMode = "text" | "image";

/** A stored listing-mode value, or text mode when it is absent or unknown. */
export const listingModeOf = (raw: string | undefined): ListingMode =>
  raw === "image" ? "image" : "text";
