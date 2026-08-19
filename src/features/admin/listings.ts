import { entityTabRoutes } from "#routes/admin/route-tables.ts";
import { idRouteFor } from "#routes/entity.ts";
import { defineRoutes } from "#routes/router.ts";
import { adminPattern } from "#shared/admin-surface.ts";
/**
 * Admin listing management routes — assembled from per-feature modules:
 *   - listings-form.ts        form parsing + create/update resources
 *   - listings-uploads.ts     attachment upload + delete handlers
 *   - listings-view.ts        detail page (attendee list + filters)
 *   - listings-export.ts      attendee CSV export
 *   - listings-edit.ts        create / duplicate / edit
 *   - listings-recalculate.ts aggregate recalculation
 *   - listings-lifecycle.ts   deactivate / reactivate / delete / log
 */

import { getListingWithCount } from "#shared/db/listings/records.ts";
import { createItemImageHandlers } from "./item-images.ts";
import { listingPage } from "./listing-page.ts";
import {
  handleAdminListingDuplicateGet,
  handleAdminListingEditPost,
  handleAdminListingIncomePost,
  handleCreateListing,
  handleNewListingGet,
} from "./listings-edit.ts";
import { handleAdminListingExport } from "./listings-export.ts";
import {
  handleAdminListingDelete,
  listingDeactivate,
  listingDelete,
  listingReactivate,
} from "./listings-lifecycle.ts";
import { handleAdminListingChildren } from "./listings-parents.ts";
import {
  handleListingRecalculateGet,
  handleListingRecalculatePost,
} from "./listings-recalculate.ts";
import { handleAttachmentDelete } from "./listings-uploads.ts";

const listingImageHandlers = createItemImageHandlers({
  disabledPath: (id) => `/admin/listing/${id}/edit`,
  itemType: "listing",
  load: getListingWithCount,
  nameOf: (listing) => listing.name,
  path: (id) => `/admin/listing/${id}/images`,
});

/** Listing routes.
 *
 * The single-listing GET surface is the tabbed entity page (listing-page.ts):
 * `/admin/listing/:id` is its Overview, `/admin/listing/:id/:tab` its other
 * tabs (attendees, edit, questions, qr, activity, actions). The router prefers
 * literal segments over the `:tab` param, so the remaining literal sub-routes
 * below (duplicate, export, new, …) and those in the scanner / qr.json / refund
 * bundles keep resolving to their own handlers. */
export const adminHandlers = defineRoutes({
  ...entityTabRoutes(adminPattern("listing"), listingPage),
  "DELETE /admin/listing/:id/delete": handleAdminListingDelete,
  "GET /admin/listing/:id/attendees.csv": handleAdminListingExport,
  "GET /admin/listing/:id/deactivate": idRouteFor(listingDeactivate.get),
  "GET /admin/listing/:id/delete": idRouteFor(listingDelete.get),
  "GET /admin/listing/:id/duplicate": handleAdminListingDuplicateGet,
  "GET /admin/listing/:id/export": handleAdminListingExport,
  "GET /admin/listing/:id/reactivate": idRouteFor(listingReactivate.get),
  "GET /admin/listing/new": handleNewListingGet,
  "GET /admin/listings/recalculate/:listingId": handleListingRecalculateGet,
  "POST /admin/listing": handleCreateListing,
  "POST /admin/listing/:id/attachment/delete": handleAttachmentDelete,
  "POST /admin/listing/:id/children": handleAdminListingChildren,
  "POST /admin/listing/:id/deactivate": idRouteFor(listingDeactivate.post),
  "POST /admin/listing/:id/delete": handleAdminListingDelete,
  "POST /admin/listing/:id/edit": handleAdminListingEditPost,
  "POST /admin/listing/:id/images": listingImageHandlers.set,
  "POST /admin/listing/:id/images/upload": listingImageHandlers.upload,
  "POST /admin/listing/:id/income": handleAdminListingIncomePost,
  "POST /admin/listing/:id/reactivate": idRouteFor(listingReactivate.post),
  "POST /admin/listings/recalculate/:listingId": handleListingRecalculatePost,
});
