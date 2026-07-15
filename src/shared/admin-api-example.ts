/**
 * Example admin API responses for documentation.
 *
 * These constants are rendered on the admin API docs page. A test validates
 * that calling toAdminListing() with the same inputs produces matching
 * output, so a shape change will break the test and force an update.
 */

import * as v from "valibot";
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
import { PackageChildrenSchema } from "#routes/api/request-schemas.ts";
import {
  API_AVAILABILITY_EXAMPLE_JSON,
  API_BOOK_FREE_EXAMPLE_JSON,
  API_EXAMPLE_LISTING,
  API_LIST_EXAMPLE_JSON,
  API_SINGLE_EXAMPLE_JSON,
} from "#shared/api-example.ts";
import type { AdminListing } from "#shared/types.ts";

/** The example AdminListing, produced by toAdminListing */
export const ADMIN_API_EXAMPLE_ADMIN_LISTING: AdminListing =
  toAdminListing(API_EXAMPLE_LISTING);

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

/** The package-book example's `children`, parsed through the LIVE request
 * schema ({@link PackageChildrenSchema}) — a drifted example is a build-time
 * parse error, so the docs can never show a body the endpoint rejects. */
const PACKAGE_BOOK_CHILDREN_EXAMPLE = v.parse(PackageChildrenSchema, [
  { parent: "tent-pitch", quantity: 1, slug: "extra-bedding" },
]);

export const PUBLIC_API_ENDPOINTS: EndpointDoc[] = [
  {
    description: "List all active, non-hidden listings",
    method: "GET",
    path: "/api/listings",
    response: API_LIST_EXAMPLE_JSON,
  },
  {
    description: "Get a single listing by slug",
    method: "GET",
    path: "/api/listings/:slug",
    response: API_SINGLE_EXAMPLE_JSON,
  },
  {
    description:
      "Check if spots are available (optional query: quantity, date)",
    method: "GET",
    path: "/api/listings/:slug/availability",
    response: API_AVAILABILITY_EXAMPLE_JSON,
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
    response: API_BOOK_FREE_EXAMPLE_JSON,
  },
  {
    description:
      "Get a package bundle by slug: its whole-bundle price (per day count for customisable-days bundles), capacity, dates, and members with their required children",
    method: "GET",
    path: "/api/packages/:slug",
    response: json({
      package: {
        description: "Two nights' camping with firepit hire",
        fields: "email,phone",
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
      children: PACKAGE_BOOK_CHILDREN_EXAMPLE,
      date: "2025-08-20",
      email: "alice@example.com",
      name: "Alice Smith",
      quantity: 1,
    }),
    response: API_BOOK_FREE_EXAMPLE_JSON,
  },
];

/** The five standard admin-CRUD doc entries for a resource. Descriptions are
 *  passed in (they carry per-resource wording — "an listing", the holiday
 *  "owner only" notes), so this shares only the method/path/request/response
 *  shape every resource repeats. `desc` is [list, get, create, update, delete]. */
const crudDocs = (c: {
  singular: string;
  plural: string;
  idParam: string;
  example: unknown;
  listResponse: unknown;
  createBody: unknown;
  updateBody: unknown;
  deleteBody: unknown;
  desc: [string, string, string, string, string];
}): EndpointDoc[] => {
  const base = `/api/admin/${c.plural}`;
  const byId = `${base}/:${c.idParam}`;
  const one = json({ [c.singular]: c.example });
  const [list, get, create, update, del] = c.desc;
  return [
    {
      description: list,
      method: "GET",
      path: base,
      response: json(c.listResponse),
    },
    { description: get, method: "GET", path: byId, response: one },
    {
      description: create,
      method: "POST",
      path: base,
      request: json(c.createBody),
      response: one,
    },
    {
      description: update,
      method: "PUT",
      path: byId,
      request: json(c.updateBody),
      response: one,
    },
    {
      description: del,
      method: "DELETE",
      path: byId,
      request: json(c.deleteBody),
      response: json({ status: "ok" }),
    },
  ];
};

export const ADMIN_API_ENDPOINTS: EndpointDoc[] = [
  ...crudDocs({
    createBody: ADMIN_API_CREATE_BODY,
    deleteBody: ADMIN_API_DELETE_BODY,
    desc: [
      "List all listings with attendee counts",
      "Get a single listing by ID",
      "Create a new listing",
      "Update an listing (all fields optional)",
      "Delete an listing (requires name confirmation)",
    ],
    example: ADMIN_API_EXAMPLE_ADMIN_LISTING,
    idParam: "listingId",
    listResponse: {
      admin_level: "owner",
      listings: [ADMIN_API_EXAMPLE_ADMIN_LISTING],
    },
    plural: "listings",
    singular: "listing",
    updateBody: ADMIN_API_UPDATE_BODY,
  }),
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
  ...crudDocs({
    createBody: ADMIN_API_GROUP_CREATE_BODY,
    deleteBody: ADMIN_API_GROUP_DELETE_BODY,
    desc: [
      "List all groups",
      "Get a single group by ID",
      "Create a new group",
      "Update a group (all fields optional)",
      "Delete a group (requires name confirmation)",
    ],
    example: ADMIN_API_EXAMPLE_GROUP,
    idParam: "groupId",
    listResponse: { groups: [ADMIN_API_EXAMPLE_GROUP] },
    plural: "groups",
    singular: "group",
    updateBody: ADMIN_API_GROUP_UPDATE_BODY,
  }),
  ...crudDocs({
    createBody: ADMIN_API_HOLIDAY_CREATE_BODY,
    deleteBody: ADMIN_API_HOLIDAY_DELETE_BODY,
    desc: [
      "List all holidays (owner only)",
      "Get a single holiday by ID (owner only)",
      "Create a holiday (owner only)",
      "Update a holiday (owner only, all fields optional)",
      "Delete a holiday (owner only, requires name confirmation)",
    ],
    example: ADMIN_API_EXAMPLE_HOLIDAY,
    idParam: "holidayId",
    listResponse: { holidays: [ADMIN_API_EXAMPLE_HOLIDAY] },
    plural: "holidays",
    singular: "holiday",
    updateBody: ADMIN_API_HOLIDAY_UPDATE_BODY,
  }),
];
