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
  selectedRecalculationFields,
} from "#routes/admin/aggregate-recalculation.ts";
import { AUTH_FORM, requireSessionOr, withAuth } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import { redirect } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import {
  getListingAggregateRecalculation,
  getListingWithCount,
  LISTING_AGGREGATE_FIELDS,
  resetListingAggregateFields,
} from "#shared/db/listings.ts";
import { getFlash } from "#shared/flash-context.ts";
import { adminListingRecalculatePage } from "#templates/admin/listings.tsx";
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
      applyFlash(request);
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
    withEntityFromParam(listingId, getListingWithCount, async (listing) => {
      const selected = selectedRecalculationFields(
        form,
        LISTING_AGGREGATE_FIELDS,
      );
      if (selected.length === 0) {
        return renderListingRecalculatePage(
          listing,
          session,
          t("listings_table.recalculate_choose"),
        );
      }
      await resetListingAggregateFields(listing.id, selected);
      await logActivity(
        `Listing '${listing.name}' totals recalculated`,
        listing,
      );
      return redirect(
        `/admin/listing/${listing.id}/edit`,
        t("listings_table.recalculate_success"),
        true,
      );
    }),
  );
