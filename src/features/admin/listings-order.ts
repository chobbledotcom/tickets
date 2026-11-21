/**
 * Move one listing before or after another, by its arrows or by a drop on
 * the listings page. The move works on the whole order, so a listing that a
 * filter hides keeps its place beside its neighbours.
 */

import { listingOrder } from "#db/listings/order.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { flatCollectionArrange } from "#db/ordered-collection.ts";
import { t } from "#i18n";
import { formPolicyFor } from "#routes/auth.ts";
import { adminDestinationAt } from "#shared/admin-surface.ts";
import { createOrderedCollectionHandlers } from "#shared/app-forms.ts";
import { loadSortedListings } from "#shared/sort-listings.ts";

export const listingOrderHandlers = createOrderedCollectionHandlers({
  arrange: flatCollectionArrange(listingOrder),
  auth: formPolicyFor(adminDestinationAt("/admin/listing/:id/move-before")),
  keys: async () =>
    (await loadSortedListings()).listings.map((listing) => listing.id),
  loadContext: ({ id }: { id: number }) => getListingWithCount(id),
  movedMessage: t("listings_table.moved"),
  redirectPath: () => "/admin/listings",
  target: ({ context }) => context.id,
});
