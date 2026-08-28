/* jscpd:ignore-start */
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";

/**
 * Admin seed data routes - populate database with sample listings and attendees
 */

import { t } from "#i18n";
import { OWNER_FORM, ownerPage, withAuth } from "#routes/auth.ts";
import { redirect } from "#routes/response.ts";
import { getFlash } from "#shared/flash-context.ts";
import { createSeeds, SEED_MAX_ATTENDEES } from "#shared/seeds.ts";
import { adminSeedsPage } from "#templates/admin/seeds.tsx";
import { MAX_SEED_LISTINGS, seedsForm } from "#templates/fields/seeds.ts";

/* jscpd:ignore-end */

/** Handle GET /admin/seeds (show seed form) */
const handleSeedsGet: TypedRouteHandler<"GET /admin/seeds"> = ownerPage(
  (session) => {
    const flash = getFlash();
    return adminSeedsPage(session, flash.error, flash.success);
  },
);

const clamp = (value: number, lo: number, hi: number): number =>
  Math.min(Math.max(lo, value), hi);

/** Handle POST /admin/seeds (create seed data) */
const handleSeedsPost: TypedRouteHandler<"POST /admin/seeds"> = (request) =>
  withAuth(request, OWNER_FORM, async (_session, form) => {
    const parsed = seedsForm.validate(form);
    if (!parsed.valid) return redirect("/admin/seeds", parsed.error, false);
    const { listing_count, attendees_per_listing } = parsed.values;
    const listingCount = clamp(listing_count, 1, MAX_SEED_LISTINGS);
    const attendeesPerListing = clamp(
      attendees_per_listing,
      0,
      SEED_MAX_ATTENDEES,
    );
    const result = await createSeeds(listingCount, attendeesPerListing);
    const message = t("admin.seeds.created", {
      attendees: result.attendeesCreated,
      listings: result.listingsCreated,
    });
    return redirect("/admin/seeds", message, true);
  });

/** Seeds routes */
export const adminHandlers = defineRoutes({
  "GET /admin/seeds": handleSeedsGet,
  "POST /admin/seeds": handleSeedsPost,
});
