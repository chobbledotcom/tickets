/**
 * Example admin API responses for documentation.
 *
 * These constants are rendered on the admin API docs page. A test validates
 * that calling toAdminListing() with the same inputs produces matching
 * output, so a shape change will break the test and force an update.
 */

import {
  type CreateListingBody,
  type DeleteListingBody,
  toAdminListing,
  type UpdateListingBody,
} from "#routes/admin/api.ts";
import {
  API_EXAMPLE_LISTING,
  API_EXAMPLE_PUBLIC_LISTING,
} from "#shared/api-example.ts";
import type { AdminListing, ListingWithCount } from "#shared/types.ts";

/** Example ListingWithCount used as the source for admin API examples */
export const ADMIN_API_EXAMPLE_LISTING: ListingWithCount = API_EXAMPLE_LISTING;

/** The example AdminListing, produced by toAdminListing */
export const ADMIN_API_EXAMPLE_ADMIN_LISTING: AdminListing = toAdminListing(
  ADMIN_API_EXAMPLE_LISTING,
);

/** Example create request body */
const ADMIN_API_CREATE_BODY = {
  date: "Sat 20 Aug 2025, 10:00 AM",
  description:
    "A hands-on workshop covering watercolours and sketching techniques.",
  fields: "email",
  listing_type: "standard",
  location: "Village Hall",
  max_attendees: 20,
  name: "Summer Workshop",
  unit_price: 1500,
} satisfies CreateListingBody;

/** Example update request body */
const ADMIN_API_UPDATE_BODY = {
  location: "Main Hall",
  max_attendees: 30,
  name: "Summer Workshop (Updated)",
} satisfies UpdateListingBody;

/** Example delete request body */
const ADMIN_API_DELETE_BODY = {
  confirm_identifier: "Summer Workshop",
} satisfies DeleteListingBody;

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
    description: "List all active, non-hidden listings",
    method: "GET",
    path: "/api/listings",
    response: json({ listings: [API_EXAMPLE_PUBLIC_LISTING] }),
  },
  {
    description: "Get a single listing by slug",
    method: "GET",
    path: "/api/listings/:slug",
    response: json({
      listing: {
        ...API_EXAMPLE_PUBLIC_LISTING,
        availableDates: ["2025-08-20", "2025-08-21"],
      },
    }),
  },
  {
    description:
      "Check if spots are available (optional query: quantity, date)",
    method: "GET",
    path: "/api/listings/:slug/availability",
    response: json({ available: true }),
  },
  {
    description: "Create a booking",
    method: "POST",
    path: "/api/listings/:slug/book",
    request: json({
      email: "alice@example.com",
      name: "Alice Smith",
      quantity: 2,
    }),
    response: json({
      booking: { ticketToken: "A1B2C3D4E5", ticketUrl: "/t/A1B2C3D4E5" },
    }),
  },
];

export const ADMIN_API_ENDPOINTS: EndpointDoc[] = [
  {
    description: "List all listings with attendee counts",
    method: "GET",
    path: "/api/admin/listings",
    response: json({
      admin_level: "owner",
      listings: [ADMIN_API_EXAMPLE_ADMIN_LISTING],
    }),
  },
  {
    description: "Get a single listing by ID",
    method: "GET",
    path: "/api/admin/listings/:listingId",
    response: json({ listing: ADMIN_API_EXAMPLE_ADMIN_LISTING }),
  },
  {
    description: "Create a new listing",
    method: "POST",
    path: "/api/admin/listings",
    request: json(ADMIN_API_CREATE_BODY),
    response: json({ listing: ADMIN_API_EXAMPLE_ADMIN_LISTING }),
  },
  {
    description: "Update an listing (all fields optional)",
    method: "PUT",
    path: "/api/admin/listings/:listingId",
    request: json(ADMIN_API_UPDATE_BODY),
    response: json({ listing: ADMIN_API_EXAMPLE_ADMIN_LISTING }),
  },
  {
    description: "Delete an listing (requires name confirmation)",
    method: "DELETE",
    path: "/api/admin/listings/:listingId",
    request: json(ADMIN_API_DELETE_BODY),
    response: json({ status: "ok" }),
  },
  {
    description: "Deactivate an listing",
    method: "POST",
    path: "/api/admin/listings/:listingId/deactivate",
    response: json({ listing: ADMIN_API_EXAMPLE_ADMIN_LISTING }),
  },
  {
    description: "Reactivate a deactivated listing",
    method: "POST",
    path: "/api/admin/listings/:listingId/reactivate",
    response: json({ listing: ADMIN_API_EXAMPLE_ADMIN_LISTING }),
  },
];
