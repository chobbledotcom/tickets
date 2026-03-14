/**
 * Admin seed data routes - populate database with sample events and attendees
 */

import { createSeeds, SEED_MAX_ATTENDEES } from "#lib/seeds.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { defineRoutes } from "#routes/router.ts";
import {
  htmlResponse,
  requireOwnerOr,
  withOwnerAuthForm,
} from "#routes/utils.ts";
import { adminSeedsPage } from "#templates/admin/seeds.tsx";

/** Max events that can be created in a single seed operation */
export const MAX_SEED_EVENTS = 30;

/** Handle GET /admin/seeds (show seed form) */
const handleSeedsGet: TypedRouteHandler<"GET /admin/seeds"> = (request) =>
  requireOwnerOr(request, (session) => htmlResponse(adminSeedsPage(session)));

/** Handle POST /admin/seeds (create seed data) */
const handleSeedsPost: TypedRouteHandler<"POST /admin/seeds"> = (request) =>
  withOwnerAuthForm(request, async (session, form) => {
    const eventCount = Math.min(
      Math.max(1, Number(form.get("event_count")) || 0),
      MAX_SEED_EVENTS,
    );
    const attendeesPerEvent = Math.min(
      Math.max(0, Number(form.get("attendees_per_event")) || 0),
      SEED_MAX_ATTENDEES,
    );

    try {
      const result = await createSeeds(eventCount, attendeesPerEvent);
      return htmlResponse(adminSeedsPage(session, undefined, result));
    } catch {
      return htmlResponse(
        adminSeedsPage(
          session,
          "Failed to create seed data. Ensure setup is complete.",
        ),
        500,
      );
    }
  });

/** Seeds routes */
export const seedsRoutes = defineRoutes({
  "GET /admin/seeds": handleSeedsGet,
  "POST /admin/seeds": handleSeedsPost,
});
