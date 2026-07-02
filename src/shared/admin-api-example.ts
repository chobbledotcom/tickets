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
import type {
  CreateGroupBody,
  DeleteGroupBody,
  UpdateGroupBody,
} from "#routes/admin/api-groups.ts";
import type {
  CreateHolidayBody,
  DeleteHolidayBody,
  UpdateHolidayBody,
} from "#routes/admin/api-holidays.ts";
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
  can_pay_more: true,
  date: "Sat 20 Aug 2025, 10:00 AM",
  description:
    "A hands-on workshop covering watercolours and sketching techniques.",
  fields: "email",
  hidden: false,
  listing_type: "standard",
  location: "Village Hall",
  max_attendees: 20,
  max_price: 3000,
  max_quantity: 4,
  name: "Summer Workshop",
  non_transferable: true,
  thank_you_url: "https://example.com/thanks",
  unit_price: 1500,
  webhook_url: "https://example.com/webhook",
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
// Group examples
// =============================================================================

/** Example group response (slug_index stripped, as the API returns it) */
const ADMIN_API_EXAMPLE_GROUP = {
  description: "Workshops running through the summer.",
  hidden: false,
  id: 3,
  max_attendees: 50,
  name: "Summer Series",
  slug: "summer-series",
  terms_and_conditions: "",
};

const ADMIN_API_GROUP_CREATE_BODY = {
  description: "Workshops running through the summer.",
  max_attendees: 50,
  name: "Summer Series",
} satisfies CreateGroupBody;

const ADMIN_API_GROUP_UPDATE_BODY = {
  hidden: true,
  name: "Summer Series (Updated)",
} satisfies UpdateGroupBody;

const ADMIN_API_GROUP_DELETE_BODY = {
  confirm_identifier: "Summer Series",
} satisfies DeleteGroupBody;

// =============================================================================
// Holiday examples (owner only)
// =============================================================================

/** Example holiday response */
const ADMIN_API_EXAMPLE_HOLIDAY = {
  end_date: "2025-12-26",
  id: 5,
  name: "Christmas",
  start_date: "2025-12-25",
};

const ADMIN_API_HOLIDAY_CREATE_BODY = {
  end_date: "2025-12-26",
  name: "Christmas",
  start_date: "2025-12-25",
} satisfies CreateHolidayBody;

const ADMIN_API_HOLIDAY_UPDATE_BODY = {
  name: "Christmas Break",
} satisfies UpdateHolidayBody;

const ADMIN_API_HOLIDAY_DELETE_BODY = {
  confirm_identifier: "Christmas",
} satisfies DeleteHolidayBody;

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

/** The booking-created response shape shared by the listing and package book endpoints. */
const API_EXAMPLE_BOOKING_RESPONSE = json({
  booking: {
    amountOwed: 0,
    ticketToken: "A1B2C3D4E5",
    ticketUrl: "/t/A1B2C3D4E5",
  },
});

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
    response: API_EXAMPLE_BOOKING_RESPONSE,
  },
  {
    description:
      "Get a package bundle by slug: its whole-bundle price (per day count for customisable-days bundles), capacity, dates, and members with their required children",
    method: "GET",
    path: "/api/packages/:slug",
    response: json({
      package: {
        description: "Two nights' camping with firepit hire",
        maxPurchasable: 5,
        members: [
          { name: "Tent Pitch", quantity: 1, slug: "tent-pitch" },
          { name: "Firepit", quantity: 1, slug: "firepit" },
        ],
        name: "Camping Weekend",
        priceMinor: 5500,
        slug: "camping-weekend",
      },
    }),
  },
  {
    description:
      "Book whole package bundles (optional: date for dated bundles, dayCount for customisable ones, children choosing each parent member's add-ons)",
    method: "POST",
    path: "/api/packages/:slug/book",
    request: json({
      children: [{ parent: "tent-pitch", quantity: 1, slug: "extra-bedding" }],
      date: "2025-08-20",
      email: "alice@example.com",
      name: "Alice Smith",
      quantity: 1,
    }),
    response: API_EXAMPLE_BOOKING_RESPONSE,
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
  // Groups (any admin)
  {
    description: "List all groups",
    method: "GET",
    path: "/api/admin/groups",
    response: json({ groups: [ADMIN_API_EXAMPLE_GROUP] }),
  },
  {
    description: "Get a single group by ID",
    method: "GET",
    path: "/api/admin/groups/:groupId",
    response: json({ group: ADMIN_API_EXAMPLE_GROUP }),
  },
  {
    description: "Create a new group",
    method: "POST",
    path: "/api/admin/groups",
    request: json(ADMIN_API_GROUP_CREATE_BODY),
    response: json({ group: ADMIN_API_EXAMPLE_GROUP }),
  },
  {
    description: "Update a group (all fields optional)",
    method: "PUT",
    path: "/api/admin/groups/:groupId",
    request: json(ADMIN_API_GROUP_UPDATE_BODY),
    response: json({ group: ADMIN_API_EXAMPLE_GROUP }),
  },
  {
    description: "Delete a group (requires name confirmation)",
    method: "DELETE",
    path: "/api/admin/groups/:groupId",
    request: json(ADMIN_API_GROUP_DELETE_BODY),
    response: json({ status: "ok" }),
  },
  // Holidays (owner only)
  {
    description: "List all holidays (owner only)",
    method: "GET",
    path: "/api/admin/holidays",
    response: json({ holidays: [ADMIN_API_EXAMPLE_HOLIDAY] }),
  },
  {
    description: "Get a single holiday by ID (owner only)",
    method: "GET",
    path: "/api/admin/holidays/:holidayId",
    response: json({ holiday: ADMIN_API_EXAMPLE_HOLIDAY }),
  },
  {
    description: "Create a holiday (owner only)",
    method: "POST",
    path: "/api/admin/holidays",
    request: json(ADMIN_API_HOLIDAY_CREATE_BODY),
    response: json({ holiday: ADMIN_API_EXAMPLE_HOLIDAY }),
  },
  {
    description: "Update a holiday (owner only, all fields optional)",
    method: "PUT",
    path: "/api/admin/holidays/:holidayId",
    request: json(ADMIN_API_HOLIDAY_UPDATE_BODY),
    response: json({ holiday: ADMIN_API_EXAMPLE_HOLIDAY }),
  },
  {
    description: "Delete a holiday (owner only, requires name confirmation)",
    method: "DELETE",
    path: "/api/admin/holidays/:holidayId",
    request: json(ADMIN_API_HOLIDAY_DELETE_BODY),
    response: json({ status: "ok" }),
  },
];
