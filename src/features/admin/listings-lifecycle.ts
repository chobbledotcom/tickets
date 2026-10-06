/**
 * Listing lifecycle routes: deactivate / reactivate / delete, plus the
 * activity-log page.
 *
 * Deactivate, reactivate and delete all share the typed-identifier
 * confirmation flow, so they are built from a common base config.
 */

import { getListingWithCount } from "#db/listings/records.ts";
/* jscpd:ignore-start */
import { t } from "#i18n";
import { createConfirmedHandlers } from "#routes/admin/confirmation.ts";
import { listingToggleStateError } from "#routes/admin/listing-toggle-state.ts";
import { AUTH_FORM, formGuard } from "#routes/auth.ts";
import { createIdEntityHandler } from "#routes/entity.ts";
import { errorRedirect, redirect } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { getSearchParam } from "#routes/url.ts";
import { deactivationOrphanedAddOnError } from "#shared/add-on-reachability.ts";
import {
  deleteOrphanedAddOnError,
  performListingDelete,
  toggleListingActive,
} from "#shared/listings-actions.ts";
import {
  adminDeactivateListingPage,
  adminListingDeletePage,
  adminReactivateListingPage,
} from "#templates/admin/listings/lifecycle.tsx";
import type { AdminSession, ListingWithCount } from "#types";

/* jscpd:ignore-end */

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
      guardError: async (listing: ListingWithCount, id: number) =>
        listingToggleStateError(listing.active, opts.active) ??
        (await opts.guardError!(id)),
    }),
    // The authoritative guard runs inside the write's transaction (see
    // onConfirm), so the framework skips its own POST-time check.
    guardInTx: true,
    onConfirm: async (listing, id) => {
      // The authoritative guard re-runs inside the write transaction, so a
      // concurrent change between the confirmation page and this POST cannot
      // orphan a child-scoped add-on.
      const result = await toggleListingActive(id, listing, opts.active);
      return "error" in result
        ? errorRedirect(`/admin/listing/${id}/${opts.action}`, result.error)
        : undefined;
    },
    path: `/admin/listing/:id/${opts.action}`,
    render: opts.renderPage,
    successMessage: `Listing ${opts.action}d`,
    successRedirect: (_, id) => `/admin/listing/${id}`,
  });

/** The error for a deactivation that orphans a child-scoped opt-in add-on.
 * The add-on then stays reachable only through its suppressed child. Null
 * when the deactivation is safe. Re-uses the shared reachability check.
 * Wired as the confirmation handler's `guardError`, not `preValidate`. The
 * deactivate GET renders the confirmation page with this error (200) instead
 * of looping by redirecting to itself. The POST still blocks the toggle. */
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

/** Confirmed-delete handlers for listings. The deactivate path's add-on
 * reachability guard also blocks a delete that orphans a child-scoped add-on.
 * The GET renders the delete confirmation page with the error (200). The POST
 * blocks before deleting. */
export const listingDelete = createConfirmedHandlers<ListingWithCount>({
  ...listingConfirmBase,
  guardError: (_listing, id) => deleteOrphanedAddOnError(id),
  // performListingDelete re-runs the guard inside the write transaction, so
  // the framework skips its own POST-time check.
  guardInTx: true,
  onConfirm: async (listing, id) => {
    // performListingDelete re-runs the guard inside the write transaction, so
    // a concurrent change since the confirmation page cannot orphan an add-on.
    const refusal = await performListingDelete(listing);
    return refusal === null
      ? undefined
      : errorRedirect(`/admin/listing/${id}/delete`, refusal);
  },
  path: "/admin/listing/:id/delete",
  render: (listing, session, error) =>
    adminListingDeletePage(listing, session, error),
  successMessage: t("success.listing_deleted"),
  successRedirect: "/admin",
});

const unverifiedListingDelete = createIdEntityHandler<ListingWithCount>(
  getListingWithCount,
)(formGuard(AUTH_FORM))(async (listing, _session, _form, _request, { id }) => {
  // performListingDelete runs the orphaned-add-on guard inside the write
  // transaction and returns its refusal. A change since the load cannot
  // orphan an add-on, and a refusal cannot be reported as success.
  const refusal = await performListingDelete(listing);
  return refusal === null
    ? redirect("/admin", t("success.listing_deleted"), true)
    : redirect(`/admin/listing/${id}`, refusal, false);
});

export const handleAdminListingDelete: TypedRouteHandler<
  "POST /admin/listing/:id/delete"
> = (request, { id }) =>
  getSearchParam(request, "verify_identifier") !== "false"
    ? listingDelete.post(request, id)
    : unverifiedListingDelete(request, { id });
