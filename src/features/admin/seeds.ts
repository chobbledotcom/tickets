/* jscpd:ignore-start */

import { defineAdminRoutes } from "#routes/admin/route-tables.ts";
import type { TypedRouteHandler } from "#routes/router.ts";

/**
 * Admin seed data routes - populate database with sample listings and attendees
 */

import { t } from "#i18n";
import { formPolicyFor, formPost, pageGuardFor } from "#routes/auth.ts";
import { authFlashPage } from "#routes/auth-flash-page.ts";
import { redirect } from "#routes/response.ts";
import { adminDestinationAt } from "#shared/admin-surface.ts";
import { createSeeds } from "#shared/seeds.ts";
import { adminSeedsPage } from "#templates/admin/seeds.tsx";
import { seedsForm } from "#templates/fields/seeds.ts";

/* jscpd:ignore-end */

/** Handle GET /admin/seeds (show seed form) */
const handleSeedsGet: TypedRouteHandler<"GET /admin/seeds"> = authFlashPage(
  pageGuardFor(adminDestinationAt("/admin/seeds")),
  (session, error, success) => adminSeedsPage(session, error, success),
);

const handleSeedsPost: TypedRouteHandler<"POST /admin/seeds"> = formPost(
  formPolicyFor(adminDestinationAt("/admin/seeds")),
)(async (form) => {
  const parsed = seedsForm.validate(form);
  if (!parsed.valid) return redirect("/admin/seeds", parsed.error, false);
  // The form schema bounds both counts (min/max on the fields), so the
  // parsed values are already inside the seeds limits.
  const { listing_count, attendees_per_listing } = parsed.values;
  const result = await createSeeds(listing_count, attendees_per_listing);
  const message = t("admin.seeds.created", {
    attendees: result.attendeesCreated,
    listings: result.listingsCreated,
  });
  return redirect("/admin/seeds", message, true);
});

/** Seeds routes */
export const adminHandlers = defineAdminRoutes({
  "GET /admin/seeds": handleSeedsGet,
  "POST /admin/seeds": handleSeedsPost,
});
