/**
 * Listing lifecycle routes: deactivate / reactivate / delete, plus the
 * activity-log page.
 *
 * Deactivate, reactivate and delete all share the typed-identifier
 * confirmation flow, so they're built from a common base config.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { createConfirmedHandlers } from "#routes/admin/confirmation.ts";
import { AUTH_FORM, withAuth } from "#routes/auth.ts";
import { authenticatedGetById } from "#routes/entity.ts";
import { htmlResponse, redirect } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { getSearchParam } from "#routes/url.ts";
import {
  getListingWithActivityLog,
  logActivity,
} from "#shared/db/activityLog.ts";
import { getListingWithCount, listingsTable } from "#shared/db/listings.ts";
import {
  deactivationOrphanedAddOnError,
  deleteOrphanedAddOnError,
  performListingDelete,
} from "#shared/listings-actions.ts";
import type { AdminSession, ListingWithCount } from "#shared/types.ts";
import { adminListingActivityLogPage } from "#templates/admin/activityLog.tsx";
import {
  adminDeactivateListingPage,
  adminDeleteListingPage,
  adminReactivateListingPage,
} from "#templates/admin/listings.tsx";
import { withEntityFromParam } from "./entity-handlers.ts";

/* jscpd:ignore-end */

/** Shared config for listing confirmation handlers */
const listingConfirmBase = {
  auth: "any" as const,
  identifier: (listing: ListingWithCount) => listing.name,
  identifierLabel: "Listing name",
  load: (_id: number) => getListingWithCount(_id),
};

/** Factory for listing toggle handlers (deactivate/reactivate) */
const listingToggleHandlers = (opts: {
  active: boolean;
  action: string;
  guardError?: (id: number) => Promise<string | null>;
  renderPage: (
    listing: ListingWithCount,
    session: AdminSession,
    error?: string,
  ) => string;
}) =>
  createConfirmedHandlers<ListingWithCount>({
    ...listingConfirmBase,
    actionLabel: `${opts.action}ion`,
    ...(opts.guardError && {
      guardError: (_listing: ListingWithCount, id: number) =>
        opts.guardError!(id),
    }),
    onConfirm: async (listing, id) => {
      await listingsTable.update(id, { active: opts.active });
      await logActivity(`Listing '${listing.name}' ${opts.action}d`, id);
    },
    path: `/admin/listing/:id/${opts.action}`,
    render: opts.renderPage,
    successMessage: `Listing ${opts.action}d`,
    successRedirect: (_, id) => `/admin/listing/${id}`,
  });

/** The error for a deactivation that would orphan a child-scoped opt-in add-on —
 * leaving it reachable only through a suppressed child (parents.md Fix 5), or
 * null when the deactivation is safe. Re-uses the shared reachability check. Wired
 * as the confirmation handler's `guardError` (not `preValidate`) so the deactivate
 * **GET renders the confirmation page WITH this error** (200) instead of looping
 * by redirecting to itself, while the POST still blocks the toggle (Fix 1). */
const deactivationOrphanError = (id: number): Promise<string | null> =>
  deactivationOrphanedAddOnError(new Set([id]));

export const listingDeactivate = listingToggleHandlers({
  action: "deactivate",
  active: false,
  guardError: deactivationOrphanError,
  renderPage: adminDeactivateListingPage,
});

export const listingReactivate = listingToggleHandlers({
  action: "reactivate",
  active: true,
  renderPage: adminReactivateListingPage,
});

/** Confirmed-delete handlers for listings. The same add-on reachability guard
 * the deactivate path uses also blocks a DELETE that would orphan a child-scoped
 * add-on (parents.md Fix 2): the GET renders the delete confirmation page with
 * the error (200), the POST blocks before deleting. */
export const listingDelete = createConfirmedHandlers<ListingWithCount>({
  ...listingConfirmBase,
  guardError: (_listing, id) => deleteOrphanedAddOnError(id),
  onConfirm: async (listing) => {
    await performListingDelete(listing);
  },
  path: "/admin/listing/:id/delete",
  render: (listing, session, error) =>
    adminDeleteListingPage(listing, session, error),
  successMessage: t("success.listing_deleted"),
  successRedirect: "/admin",
});

/**
 * Handle GET /admin/listing/:id/log
 * Uses batched query to fetch listing + activity log in a single DB round-trip.
 */
export const handleAdminListingLog = authenticatedGetById(null)(
  getListingWithActivityLog,
  (result, session) =>
    htmlResponse(
      adminListingActivityLogPage(result.listing, result.entries, session),
    ),
);

/** Handle DELETE /admin/listing/:id (delete listing with logging) */
export const handleAdminListingDelete: TypedRouteHandler<
  "POST /admin/listing/:id/delete"
> = (request, { id }) =>
  getSearchParam(request, "verify_identifier") !== "false"
    ? listingDelete.post(request, id)
    : withAuth(request, AUTH_FORM, () =>
        withEntityFromParam(id, getListingWithCount, async (listing) => {
          // Same orphaned-add-on guard as the confirmed path (Fix 2): block a
          // delete that would leave a child-scoped add-on unreachable.
          const error = await deleteOrphanedAddOnError(listing.id);
          if (error) return redirect(`/admin/listing/${id}`, error, false);
          await performListingDelete(listing);
          return redirect("/admin", t("success.listing_deleted"), true);
        }),
      );
