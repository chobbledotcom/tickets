/**
 * Listing aggregate recalculation routes.
 *
 * Lets an operator reset the trigger-maintained totals (booked quantity,
 * income, tickets count) for a listing back to a freshly computed value.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import {
  createRecalculatePageRenderer,
  runRecalculatePost,
} from "#routes/admin/aggregate-recalculation.ts";
import { AUTH_FORM, requireSessionOr, withAuth } from "#routes/auth.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import {
  getListingAggregateRecalculation,
  LISTING_AGGREGATE_FIELDS,
  resetListingAggregateFields,
} from "#shared/db/listings/aggregates.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import { getFlash } from "#shared/flash-context.ts";
import { adminListingRecalculatePage } from "#templates/admin/listings/aggregates.tsx";
import { withEntityFromParam } from "./entity-handlers.ts";

/* jscpd:ignore-end */

const renderListingRecalculatePage = createRecalculatePageRenderer(
  getListingAggregateRecalculation,
  adminListingRecalculatePage,
);

export const handleListingRecalculateGet: TypedRouteHandler<
  "GET /admin/listings/recalculate/:listingId"
> = (request, { listingId }) =>
  requireSessionOr(request, (session) =>
    withEntityFromParam(listingId, getListingWithCount, (listing) => {
      const flash = getFlash();
      return renderListingRecalculatePage(
        listing,
        session,
        flash.error,
        flash.success,
      );
    }),
  );

export const handleListingRecalculatePost: TypedRouteHandler<
  "POST /admin/listings/recalculate/:listingId"
> = (request, { listingId }) =>
  withAuth(request, AUTH_FORM, (session, form) =>
    withEntityFromParam(listingId, getListingWithCount, (listing) =>
      runRecalculatePost({
        fields: LISTING_AGGREGATE_FIELDS,
        form,
        log: () =>
          logActivity(`Listing '${listing.name}' totals recalculated`, listing),
        renderChoose: () =>
          renderListingRecalculatePage(
            listing,
            session,
            t("listings_table.recalculate_choose"),
          ),
        reset: (selected) => resetListingAggregateFields(listing.id, selected),
        successMessage: t("listings_table.recalculate_success"),
        successPath: `/admin/listing/${listing.id}/edit`,
      }),
    ),
  );
