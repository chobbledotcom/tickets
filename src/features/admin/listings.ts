/**
 * Admin listing management routes — assembled from per-feature modules:
 *   - listings-form.ts        form parsing + create/update resources
 *   - listings-uploads.ts     image/attachment upload + delete handlers
 *   - listings-view.ts        detail page (attendee list + filters)
 *   - listings-export.ts      attendee CSV export
 *   - listings-edit.ts        create / duplicate / edit
 *   - listings-recalculate.ts aggregate recalculation
 *   - listings-lifecycle.ts   deactivate / reactivate / delete / log
 */

import { defineRoutes } from "#routes/router.ts";
import {
  handleAdminListingDuplicateGet,
  handleAdminListingEditGet,
  handleAdminListingEditPost,
  handleAdminListingIncomePost,
  handleCreateListing,
  handleNewListingGet,
} from "./listings-edit.ts";
import { handleAdminListingExport } from "./listings-export.ts";
import {
  handleAdminListingDelete,
  handleAdminListingLog,
  listingDeactivate,
  listingDelete,
  listingReactivate,
} from "./listings-lifecycle.ts";
import { handleAdminListingChildren } from "./listings-parents.ts";
import {
  handleListingRecalculateGet,
  handleListingRecalculatePost,
} from "./listings-recalculate.ts";
import {
  handleAttachmentDelete,
  handleImageDelete,
} from "./listings-uploads.ts";
import {
  handleAdminListingGet,
  handleAdminListingGetIn,
  handleAdminListingGetOut,
} from "./listings-view.ts";

/** Listing routes */
export const listingsRoutes = {
  ...listingDeactivate.routes,
  ...listingReactivate.routes,
  ...listingDelete.routes,
  ...defineRoutes({
    "DELETE /admin/listing/:id/delete": handleAdminListingDelete,
    "GET /admin/listing/:id": handleAdminListingGet,
    "GET /admin/listing/:id/duplicate": handleAdminListingDuplicateGet,
    "GET /admin/listing/:id/edit": handleAdminListingEditGet,
    "GET /admin/listing/:id/export": handleAdminListingExport,
    "GET /admin/listing/:id/in": handleAdminListingGetIn,
    "GET /admin/listing/:id/log": handleAdminListingLog,
    "GET /admin/listing/:id/out": handleAdminListingGetOut,
    "GET /admin/listing/new": handleNewListingGet,
    "GET /admin/listings/recalculate/:listingId": handleListingRecalculateGet,
    "POST /admin/listing": handleCreateListing,
    "POST /admin/listing/:id/attachment/delete": handleAttachmentDelete,
    "POST /admin/listing/:id/children": handleAdminListingChildren,
    "POST /admin/listing/:id/delete": handleAdminListingDelete,
    "POST /admin/listing/:id/edit": handleAdminListingEditPost,
    "POST /admin/listing/:id/image/delete": handleImageDelete,
    "POST /admin/listing/:id/income": handleAdminListingIncomePost,
    "POST /admin/listings/recalculate/:listingId": handleListingRecalculatePost,
  }),
};
