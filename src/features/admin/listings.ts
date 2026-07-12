import { handlersFor } from "#routes/admin/handlers.ts";
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
export const adminHandlers = handlersFor("listings")({
  deleteListingByIdDelete: handleAdminListingDelete,
  getListingById: (request, { id }) => listingPage.renderTab(request, id, ""),
  getListingByIdAttendeesCsv: handleAdminListingExport,
  getListingByIdByTab: (request, { id, tab }) =>
    listingPage.renderTab(request, id, tab),
  getListingByIdDeactivate: (request, { id }) =>
    listingDeactivate.get(request, id),
  getListingByIdDelete: (request, { id }) => listingDelete.get(request, id),
  getListingByIdDuplicate: handleAdminListingDuplicateGet,
  getListingByIdExport: handleAdminListingExport,
  getListingByIdReactivate: (request, { id }) =>
    listingReactivate.get(request, id),
  getListingNew: handleNewListingGet,
  getListingsRecalculateByListingId: handleListingRecalculateGet,
  postListing: handleCreateListing,
  postListingByIdAttachmentDelete: handleAttachmentDelete,
  postListingByIdChildren: handleAdminListingChildren,
  postListingByIdDeactivate: (request, { id }) =>
    listingDeactivate.post(request, id),
  postListingByIdDelete: handleAdminListingDelete,
  postListingByIdEdit: handleAdminListingEditPost,
  postListingByIdImages: listingImageHandlers.set,
  postListingByIdImagesUpload: listingImageHandlers.upload,
  postListingByIdIncome: handleAdminListingIncomePost,
  postListingByIdReactivate: (request, { id }) =>
    listingReactivate.post(request, id),
  postListingsRecalculateByListingId: handleListingRecalculatePost,
});
