/**
 * Admin seed data routes - populate database with sample listings and attendees
 */

import { OWNER_FORM, ownerPage, withAuth } from "#routes/auth.ts";
import { redirect } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { defineRoutes } from "#routes/router.ts";
import { getFlash } from "#shared/flash-context.ts";
import { defineForm } from "#shared/forms.tsx";
import { createSeeds, SEED_MAX_ATTENDEES } from "#shared/seeds.ts";
import { adminSeedsPage } from "#templates/admin/seeds.tsx";

/** Max listings that can be created in a single seed operation */
export const MAX_SEED_LISTINGS = 30;

export const seedsForm = defineForm({
  fields: [
    {
      defaultValue: "5",
      id: "listing_count",
      label: "Number of listings",
      max: MAX_SEED_LISTINGS,
      min: 1,
      name: "listing_count",
      required: true,
      type: "number",
    },
    {
      defaultValue: "10",
      id: "attendees_per_listing",
      label: "Attendees per listing",
      max: SEED_MAX_ATTENDEES,
      min: 0,
      name: "attendees_per_listing",
      required: true,
      type: "number",
    },
  ] as const,
  id: "seeds",
});

/** Handle GET /admin/seeds (show seed form) */
const handleSeedsGet: TypedRouteHandler<"GET /admin/seeds"> = ownerPage(
  (session) => {
    const flash = getFlash();
    return adminSeedsPage(session, flash.error, flash.success);
  },
);

const clamp = (value: number | null, lo: number, hi: number): number =>
  Math.min(Math.max(lo, value == null || Number.isNaN(value) ? lo : value), hi);

/** Handle POST /admin/seeds (create seed data) */
const handleSeedsPost: TypedRouteHandler<"POST /admin/seeds"> = (request) =>
  withAuth(request, OWNER_FORM, async (_session, form) => {
    const { listing_count, attendees_per_listing } = (
      seedsForm.validate(form) as {
        valid: true;
        values: { attendees_per_listing: number; listing_count: number };
      }
    ).values;
    const listingCount = clamp(listing_count, 1, MAX_SEED_LISTINGS);
    const attendeesPerListing = clamp(
      attendees_per_listing,
      0,
      SEED_MAX_ATTENDEES,
    );
    try {
      const result = await createSeeds(listingCount, attendeesPerListing);
      const message = `Created ${result.listingsCreated} listing(s) with ${result.attendeesCreated} attendee(s) total.`;
      return redirect("/admin/seeds", message, true);
    } catch {
      return redirect(
        "/admin/seeds",
        "Failed to create seed data. Ensure setup is complete.",
        false,
      );
    }
  });

/** Seeds routes */
export const seedsRoutes = defineRoutes({
  "GET /admin/seeds": handleSeedsGet,
  "POST /admin/seeds": handleSeedsPost,
});
