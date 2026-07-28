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
import { API_EXAMPLE_LISTING } from "#shared/api-example.ts";
import { listingCatalogFields } from "#shared/catalog-fields/fields.ts";
import { VALID_DAY_NAMES } from "#shared/day-names.ts";
import type { AdminListing } from "#shared/types.ts";
import { type EndpointDoc, json } from "./admin-api-example/endpoint-doc.ts";

export type { EndpointDoc } from "./admin-api-example/endpoint-doc.ts";
export { PUBLIC_API_ENDPOINTS } from "./admin-api-example/public.ts";

/** The example listing exactly as the admin endpoints answer with it: the
 * stored fields, plus the ids of the groups it is in. The example is in none. */
export const ADMIN_API_EXAMPLE_ADMIN_LISTING: AdminListing & {
  group_ids: number[];
} = { ...toAdminListing(API_EXAMPLE_LISTING), group_ids: [] };

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
  hide_package_listings: false,
  id: 3,
  is_package: false,
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

/** The booking window a listing gets when its create body says nothing. */
const LISTING_DEFAULT_DAYS_AFTER = listingCatalogFields.maximumDaysAfter[4];

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
  /** Fields a brand-new record always has, whatever the caller sent — the
   * running totals that only bookings can move. */
  freshRecord?: Record<string, number>;
  /** What the stored defaults give a new record where the create body is
   * silent, for fields whose default differs from the example record. */
  newRecordDefaults?: Record<string, unknown>;
}): EndpointDoc[] => {
  const base = `/api/admin/${c.plural}`;
  const byId = `${base}/:${c.idParam}`;
  /** The stored record as an endpoint answers with it: the example with the
   * given changes laid over it. */
  const answerWith = (...changes: unknown[]): string =>
    json({ [c.singular]: Object.assign({}, c.example, ...changes) });
  const one = answerWith();
  // An update answers with the record as it now reads, and a create with the
  // record as just stored: what the caller sent, over the defaults, with
  // nothing yet booked against it.
  const updated = answerWith(c.updateBody);
  const created = answerWith(
    c.newRecordDefaults ?? {},
    c.createBody,
    c.freshRecord ?? {},
  );
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
      response: created,
    },
    {
      description: update,
      method: "PUT",
      path: byId,
      request: json(c.updateBody),
      response: updated,
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
    freshRecord: {
      attendee_count: 0,
      cost: 0,
      income: 0,
      profit: 0,
      tickets_count: 0,
    },
    idParam: "listingId",
    listResponse: {
      admin_level: "owner",
      listings: [ADMIN_API_EXAMPLE_ADMIN_LISTING],
    },
    // What a listing gets when the create body does not say. Both come from
    // the stored column defaults, so the documentation cannot drift from them.
    newRecordDefaults: {
      bookable_days: [...VALID_DAY_NAMES],
      maximum_days_after: LISTING_DEFAULT_DAYS_AFTER,
    },
    plural: "listings",
    singular: "listing",
    updateBody: ADMIN_API_UPDATE_BODY,
  }),
  {
    description: "Deactivate an listing",
    method: "POST",
    path: "/api/admin/listings/:listingId/deactivate",
    response: json({
      listing: { ...ADMIN_API_EXAMPLE_ADMIN_LISTING, active: false },
    }),
  },
  {
    description: "Reactivate a deactivated listing",
    method: "POST",
    path: "/api/admin/listings/:listingId/reactivate",
    response: json({
      listing: { ...ADMIN_API_EXAMPLE_ADMIN_LISTING, active: true },
    }),
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
