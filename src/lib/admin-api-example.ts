/**
 * Example admin API responses for documentation.
 *
 * These constants are rendered on the admin API docs page. A test validates
 * that calling toAdminEvent() with the same inputs produces matching
 * output, so a shape change will break the test and force an update.
 */

import {
  API_EXAMPLE_EVENT,
  API_EXAMPLE_PUBLIC_EVENT,
} from "#lib/api-example.ts";
import type { AdminEvent, EventWithCount } from "#lib/types.ts";
import {
  type CreateEventBody,
  type DeleteEventBody,
  toAdminEvent,
  type UpdateEventBody,
} from "#routes/admin/api.ts";

/** Example EventWithCount used as the source for admin API examples */
export const ADMIN_API_EXAMPLE_EVENT: EventWithCount = API_EXAMPLE_EVENT;

/** The example AdminEvent, produced by toAdminEvent */
export const ADMIN_API_EXAMPLE_ADMIN_EVENT: AdminEvent = toAdminEvent(
  ADMIN_API_EXAMPLE_EVENT,
);

/** Example create request body */
const ADMIN_API_CREATE_BODY = {
  name: "Summer Workshop",
  max_attendees: 20,
  description:
    "A hands-on workshop covering watercolours and sketching techniques.",
  date: "Sat 20 Aug 2025, 10:00 AM",
  location: "Village Hall",
  unit_price: 1500,
  fields: "email",
  event_type: "standard",
} satisfies CreateEventBody;

/** Example update request body */
const ADMIN_API_UPDATE_BODY = {
  name: "Summer Workshop (Updated)",
  max_attendees: 30,
  location: "Main Hall",
} satisfies UpdateEventBody;

/** Example delete request body */
const ADMIN_API_DELETE_BODY = {
  confirm_name: "Summer Workshop",
} satisfies DeleteEventBody;

// =============================================================================
// Endpoint documentation entries
// =============================================================================

/** A documented API endpoint with example request and response */
export type EndpointDoc = {
  method: string;
  path: string;
  description: string;
  request?: string;
  response: string;
};

const json = (data: unknown): string => JSON.stringify(data, null, 2);

export const PUBLIC_API_ENDPOINTS: EndpointDoc[] = [
  {
    method: "GET",
    path: "/api/events",
    description: "List all active, non-hidden events",
    response: json({ events: [API_EXAMPLE_PUBLIC_EVENT] }),
  },
  {
    method: "GET",
    path: "/api/events/:slug",
    description: "Get a single event by slug",
    response: json({
      event: {
        ...API_EXAMPLE_PUBLIC_EVENT,
        availableDates: ["2025-08-20", "2025-08-21"],
      },
    }),
  },
  {
    method: "GET",
    path: "/api/events/:slug/availability",
    description:
      "Check if spots are available (optional query: quantity, date)",
    response: json({ available: true }),
  },
  {
    method: "POST",
    path: "/api/events/:slug/book",
    description: "Create a booking",
    request: json({
      name: "Alice Smith",
      email: "alice@example.com",
      quantity: 2,
    }),
    response: json({ ticketToken: "A1B2C3D4E5", ticketUrl: "/t/A1B2C3D4E5" }),
  },
];

export const ADMIN_API_ENDPOINTS: EndpointDoc[] = [
  {
    method: "GET",
    path: "/api/admin/events",
    description: "List all events with attendee counts",
    response: json({
      events: [ADMIN_API_EXAMPLE_ADMIN_EVENT],
      admin_level: "owner",
    }),
  },
  {
    method: "GET",
    path: "/api/admin/events/:eventId",
    description: "Get a single event by ID",
    response: json({ event: ADMIN_API_EXAMPLE_ADMIN_EVENT }),
  },
  {
    method: "POST",
    path: "/api/admin/events",
    description: "Create a new event",
    request: json(ADMIN_API_CREATE_BODY),
    response: json({ event: ADMIN_API_EXAMPLE_ADMIN_EVENT }),
  },
  {
    method: "PUT",
    path: "/api/admin/events/:eventId",
    description: "Update an event (all fields optional)",
    request: json(ADMIN_API_UPDATE_BODY),
    response: json({ event: ADMIN_API_EXAMPLE_ADMIN_EVENT }),
  },
  {
    method: "DELETE",
    path: "/api/admin/events/:eventId",
    description: "Delete an event (requires name confirmation)",
    request: json(ADMIN_API_DELETE_BODY),
    response: json({ status: "ok" }),
  },
  {
    method: "POST",
    path: "/api/admin/events/:eventId/deactivate",
    description: "Deactivate an event",
    response: json({ event: ADMIN_API_EXAMPLE_ADMIN_EVENT }),
  },
  {
    method: "POST",
    path: "/api/admin/events/:eventId/reactivate",
    description: "Reactivate a deactivated event",
    response: json({ event: ADMIN_API_EXAMPLE_ADMIN_EVENT }),
  },
];
