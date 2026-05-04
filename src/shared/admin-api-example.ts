/**
 * Example admin API responses for documentation.
 *
 * These constants are rendered on the admin API docs page. A test validates
 * that calling toAdminEvent() with the same inputs produces matching
 * output, so a shape change will break the test and force an update.
 */

import {
  type CreateEventBody,
  type DeleteEventBody,
  toAdminEvent,
  type UpdateEventBody,
} from "#routes/admin/api.ts";
import {
  API_EXAMPLE_EVENT,
  API_EXAMPLE_PUBLIC_EVENT,
} from "#shared/api-example.ts";
import type { AdminEvent, EventWithCount } from "#shared/types.ts";

/** Example EventWithCount used as the source for admin API examples */
export const ADMIN_API_EXAMPLE_EVENT: EventWithCount = API_EXAMPLE_EVENT;

/** The example AdminEvent, produced by toAdminEvent */
export const ADMIN_API_EXAMPLE_ADMIN_EVENT: AdminEvent = toAdminEvent(
  ADMIN_API_EXAMPLE_EVENT,
);

/** Example create request body */
const ADMIN_API_CREATE_BODY = {
  date: "Sat 20 Aug 2025, 10:00 AM",
  description:
    "A hands-on workshop covering watercolours and sketching techniques.",
  event_type: "standard",
  fields: "email",
  location: "Village Hall",
  max_attendees: 20,
  name: "Summer Workshop",
  unit_price: 1500,
} satisfies CreateEventBody;

/** Example update request body */
const ADMIN_API_UPDATE_BODY = {
  location: "Main Hall",
  max_attendees: 30,
  name: "Summer Workshop (Updated)",
} satisfies UpdateEventBody;

/** Example delete request body */
const ADMIN_API_DELETE_BODY = {
  confirm_identifier: "Summer Workshop",
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
    description: "List all active, non-hidden events",
    method: "GET",
    path: "/api/events",
    response: json({ events: [API_EXAMPLE_PUBLIC_EVENT] }),
  },
  {
    description: "Get a single event by slug",
    method: "GET",
    path: "/api/events/:slug",
    response: json({
      event: {
        ...API_EXAMPLE_PUBLIC_EVENT,
        availableDates: ["2025-08-20", "2025-08-21"],
      },
    }),
  },
  {
    description:
      "Check if spots are available (optional query: quantity, date)",
    method: "GET",
    path: "/api/events/:slug/availability",
    response: json({ available: true }),
  },
  {
    description: "Create a booking",
    method: "POST",
    path: "/api/events/:slug/book",
    request: json({
      email: "alice@example.com",
      name: "Alice Smith",
      quantity: 2,
    }),
    response: json({ ticketToken: "A1B2C3D4E5", ticketUrl: "/t/A1B2C3D4E5" }),
  },
];

export const ADMIN_API_ENDPOINTS: EndpointDoc[] = [
  {
    description: "List all events with attendee counts",
    method: "GET",
    path: "/api/admin/events",
    response: json({
      admin_level: "owner",
      events: [ADMIN_API_EXAMPLE_ADMIN_EVENT],
    }),
  },
  {
    description: "Get a single event by ID",
    method: "GET",
    path: "/api/admin/events/:eventId",
    response: json({ event: ADMIN_API_EXAMPLE_ADMIN_EVENT }),
  },
  {
    description: "Create a new event",
    method: "POST",
    path: "/api/admin/events",
    request: json(ADMIN_API_CREATE_BODY),
    response: json({ event: ADMIN_API_EXAMPLE_ADMIN_EVENT }),
  },
  {
    description: "Update an event (all fields optional)",
    method: "PUT",
    path: "/api/admin/events/:eventId",
    request: json(ADMIN_API_UPDATE_BODY),
    response: json({ event: ADMIN_API_EXAMPLE_ADMIN_EVENT }),
  },
  {
    description: "Delete an event (requires name confirmation)",
    method: "DELETE",
    path: "/api/admin/events/:eventId",
    request: json(ADMIN_API_DELETE_BODY),
    response: json({ status: "ok" }),
  },
  {
    description: "Deactivate an event",
    method: "POST",
    path: "/api/admin/events/:eventId/deactivate",
    response: json({ event: ADMIN_API_EXAMPLE_ADMIN_EVENT }),
  },
  {
    description: "Reactivate a deactivated event",
    method: "POST",
    path: "/api/admin/events/:eventId/reactivate",
    response: json({ event: ADMIN_API_EXAMPLE_ADMIN_EVENT }),
  },
];
