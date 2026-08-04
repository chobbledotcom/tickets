/**
 * Listing aggregate recalculation routes.
 *
 * Lets an operator reset the trigger-maintained totals (booked quantity,
 * income, tickets count) for a listing back to a freshly computed value.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import {
  createRecalculateHandlers,
  createRecalculatePageRenderer,
} from "#routes/admin/aggregate-recalculation.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { logActivity } from "#shared/db/activity-log.ts";
import {
  getListingAggregateRecalculation,
  LISTING_AGGREGATE_FIELDS,
  resetListingAggregateFields,
} from "#shared/db/listings/aggregates.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import { adminListingRecalculatePage } from "#templates/admin/listings/aggregates.tsx";
import { withEntityFromParam } from "./entity-handlers.ts";

/* jscpd:ignore-end */

const renderListingRecalculatePage = createRecalculatePageRenderer(
  getListingAggregateRecalculation,
  adminListingRecalculatePage,
);

const listingRecalculateHandlers = createRecalculateHandlers({
  chooseMessage: t("listings_table.recalculate_choose"),
  entityId: (listing) => listing.id,
  fields: LISTING_AGGREGATE_FIELDS,
  log: (listing) =>
    logActivity(`Listing '${listing.name}' totals recalculated`, listing),
  render: renderListingRecalculatePage,
  reset: resetListingAggregateFields,
  successMessage: t("listings_table.recalculate_success"),
  successPath: (listing) => `/admin/listing/${listing.id}/edit`,
  withEntity: (id: string | number | undefined) => (handler) =>
    withEntityFromParam(id, getListingWithCount, handler),
});

export const handleListingRecalculateGet: TypedRouteHandler<
  "GET /admin/listings/recalculate/:listingId"
> = (request, { listingId }) =>
  listingRecalculateHandlers.get(request, listingId);

export const handleListingRecalculatePost: TypedRouteHandler<
  "POST /admin/listings/recalculate/:listingId"
> = (request, { listingId }) =>
  listingRecalculateHandlers.post(request, listingId);
