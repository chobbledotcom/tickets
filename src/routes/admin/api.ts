/**
 * Admin JSON API routes — accessible via API key or cookie+CSRF.
 *
 * These endpoints expose admin operations as JSON for programmatic access.
 * Authentication is handled by withAdminApi which accepts either:
 *   - Bearer token (API key) — no CSRF needed
 *   - Session cookie + x-csrf-token header
 */

import { getAllEvents } from "#lib/db/events.ts";
import { defineRoutes } from "#routes/router.ts";
import { jsonResponse, withAdminApi } from "#routes/utils.ts";

/** GET /api/admin/events — list all events with counts */
const handleListEvents = (request: Request): Promise<Response> =>
  withAdminApi(request, async (session) => {
    const events = await getAllEvents();
    return jsonResponse({
      events: events.map((e) => ({
        id: e.id,
        name: e.name,
        slug: e.slug,
        active: e.active,
        maxAttendees: e.max_attendees,
        attendeeCount: e.attendee_count,
        unitPrice: e.unit_price,
        eventType: e.event_type,
        hidden: e.hidden,
      })),
      adminLevel: session.adminLevel,
    });
  });

export const adminApiRoutes = defineRoutes({
  "GET /api/admin/events": handleListEvents,
});
