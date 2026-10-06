import { bookingError } from "#booking/form.ts";
import { quantityBelowMin } from "#booking/model.ts";

/** The below-minimum error for one submitted quantity: the caller's message
 *  when the quantity refuses the stored minimum, else null. Each surface
 *  names its own copy and shapes its own failure object around it. */
export const belowMinError = (
  quantity: number,
  minimum: number,
  error: string,
): string | null => (quantityBelowMin(quantity, minimum) ? error : null);

/** The member facts one bundle count serves: each member's fixed per-package
 *  units beside its stored minimum and name. An id with no loaded listing
 *  row drops out. */
export const packageBundleMembers = (
  fixedByListingId: ReadonlyMap<number, number>,
  listingById: ReadonlyMap<number, { min_quantity: number; name: string }>,
): { fixed: number; minQuantity: number; name: string }[] =>
  [...fixedByListingId].flatMap(([listingId, fixed]) => {
    const listing = listingById.get(listingId);
    return listing === undefined
      ? []
      : [{ fixed, minQuantity: listing.min_quantity, name: listing.name }];
  });

/** The below-minimum refusal for one package bundle count: the first member
 *  whose units the bundles serve below its per-purchase minimum. An owner
 *  can raise a member's minimum after the package was saved, so the fold
 *  re-reads the stored fact the same way the webhook does. Zero bundles
 *  book nothing and pass. */
export const packageBundleMinError = (
  members: readonly { fixed: number; minQuantity: number; name: string }[],
  bundleCount: number,
): string | null => {
  if (bundleCount === 0) return null;
  for (const member of members) {
    if (quantityBelowMin(member.fixed * bundleCount, member.minQuantity)) {
      return bookingError.minimum(member.name, member.minQuantity);
    }
  }
  return null;
};
