/**
 * Admin JSON API routes — accessible via API key or cookie+CSRF.
 *
 * These endpoints expose admin operations as JSON for programmatic access.
 * Authentication is handled by withAdminApi which accepts either:
 *   - Bearer token (API key) — no CSRF needed
 *   - Session cookie + x-csrf-token header
 */

import { map } from "#fp";
import { getAllEvents } from "#lib/db/events.ts";
import type { AdminEvent, EventWithCount } from "#lib/types.ts";
import { defineRoutes } from "#routes/router.ts";
import { jsonResponse, withAdminApi } from "#routes/utils.ts";

/** Strip internal fields from an event, returning the admin API shape */
export const toAdminEvent = ({
  slug_index: _,
  ...event
}: EventWithCount): AdminEvent => event;

/** GET /api/admin/events — list all events with counts */
const handleListEvents = (request: Request): Promise<Response> =>
  withAdminApi(request, async (session) => {
    const events = await getAllEvents();
    return jsonResponse({
      events: map(toAdminEvent)(events),
      admin_level: session.adminLevel,
    });
  });

export const adminApiRoutes = defineRoutes({
  "GET /api/admin/events": handleListEvents,
});
