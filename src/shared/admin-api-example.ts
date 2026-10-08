/**
 * Example admin API responses for documentation.
 *
 * These constants are rendered on the admin API docs page. A test validates
 * that calling toAdminListing() with the same inputs produces matching
 * output, so a shape change will break the test and force an update.
 */

import { type AdminApiAttendee, toAdminListing } from "#routes/admin/api.ts";
import type {
  AttributeOptionBody,
  CreateAttributeBody,
  UpdateAttributeBody,
} from "#routes/admin/api-attributes.ts";
import type {
  CreateGroupBody,
  UpdateGroupBody,
} from "#routes/admin/api-groups.ts";
import type {
  CreateHolidayBody,
  UpdateHolidayBody,
} from "#routes/admin/api-holidays.ts";
import type {
  CreateListingBody,
  UpdateListingBody,
} from "#routes/admin/api-listing-body.ts";
import {
  ADMIN_API_RESOURCES,
  type AdminApiResource,
  adminApiIdParam,
} from "#shared/admin-api-resources.ts";
import { API_EXAMPLE_LISTING } from "#shared/api-example.ts";
import { listingCatalogFields } from "#shared/catalog-fields/fields.ts";
import { VALID_DAY_NAMES } from "#shared/day-names.ts";
import type { DeleteBody } from "#shared/rest/crud-parsers.ts";
import type { AdminListing } from "#types";
import { type EndpointDoc, json } from "./admin-api-example/endpoint-doc.ts";

/** The running totals a listing carries. Only a booking can move them, so a
 * listing that was just created has none of each. */
export const BOOKING_TOTAL_FIELDS = [
  "attendee_count",
  "cost",
  "income",
  "profit",
  "tickets_count",
];

/** The example listing, exactly as the admin endpoints answer with it. It
 * adds the ids of the groups it is in and the attribute options it selects.
 * The example is in neither. */
export const ADMIN_API_EXAMPLE_ADMIN_LISTING: AdminListing & {
  attribute_option_ids: number[];
  group_ids: number[];
} = {
  ...toAdminListing(API_EXAMPLE_LISTING),
  attribute_option_ids: [],
  group_ids: [],
};

/** Example create request body */
const ADMIN_API_CREATE_BODY = {
  can_pay_more: true,
  // Written in the form storage reads back, so the create answer below can
  // show the same string the caller sent.
  date: "2025-08-20T10:00:00.000Z",
  description:
    "A hands-on workshop covering watercolours and sketching techniques.",
  fields: "email",
  hidden: false,
  listing_type: "standard",
  location: "Village Hall",
  max_attendees: 20,
  max_price: 3000,
  max_quantity: 4,
  min_quantity: 1,
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
} satisfies DeleteBody;

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
  show_hidden_listings: true,
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
} satisfies DeleteBody;

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
} satisfies DeleteBody;

// =============================================================================
// Attribute examples (owner only)
// =============================================================================

/** Example attribute response: the attribute and its options in display
 * order. */
const ADMIN_API_EXAMPLE_ATTRIBUTE = {
  id: 6,
  name: "Difficulty",
  options: [
    { attribute_id: 6, id: 11, sort_order: 0, text: "Easy" },
    { attribute_id: 6, id: 12, sort_order: 1, text: "Hard" },
  ],
  sort_order: 2,
};

const ADMIN_API_ATTRIBUTE_CREATE_BODY = {
  name: "Difficulty",
} satisfies CreateAttributeBody;

const ADMIN_API_ATTRIBUTE_UPDATE_BODY = {
  name: "Difficulty (Updated)",
} satisfies UpdateAttributeBody;

const ADMIN_API_ATTRIBUTE_DELETE_BODY = {
  confirm_identifier: "Difficulty",
} satisfies DeleteBody;

const ADMIN_API_ATTRIBUTE_OPTION_CREATE_BODY = {
  text: "Medium",
} satisfies AttributeOptionBody;

const ADMIN_API_ATTRIBUTE_OPTION_UPDATE_BODY = {
  text: "Very hard",
} satisfies AttributeOptionBody;

const ADMIN_API_ATTRIBUTE_OPTION_DELETE_BODY = {
  confirm_identifier: "Hard",
} satisfies DeleteBody;

const ADMIN_API_EXAMPLE_ATTRIBUTE_WITH_MEDIUM = {
  ...ADMIN_API_EXAMPLE_ATTRIBUTE,
  options: [
    ...ADMIN_API_EXAMPLE_ATTRIBUTE.options,
    { attribute_id: 6, id: 13, sort_order: 2, text: "Medium" },
  ],
};

/** The answer to an option rename: the attribute's own name is untouched, so
 * the example must not read like the request also renames the attribute. */
const ADMIN_API_EXAMPLE_OPTION_RENAMED = {
  ...ADMIN_API_EXAMPLE_ATTRIBUTE,
  options: ADMIN_API_EXAMPLE_ATTRIBUTE.options.map((option) => ({
    ...option,
    text: option.text === "Hard" ? "Very hard" : option.text,
  })),
};

/** Example attendee booking row, exactly as the attendees endpoint answers
 * with it: the decrypted roster row minus the sealed PII blob and its blind
 * index. A standard listing holds no booking date, so both span fields are
 * null; a daily listing would carry its booked day number instead. */
const ADMIN_API_EXAMPLE_ATTENDEE = {
  address: "12 Main Street, Springfield",
  attachment_downloads: 0,
  // A count of the line's admitted tickets, 0 up to quantity: one of two in.
  checked_in: 1,
  created: "2026-06-01T10:00:00.000Z",
  date: null,
  email: "jane@example.com",
  end_date: null,
  id: 7,
  kind: "attendee",
  lat: "",
  listing_id: 4,
  lng: "",
  name: "Jane Doe",
  package_group_id: 0,
  payment_id: "pi_3Qx1aB2c",
  phone: "+1 555 0123",
  price_paid: "5000",
  quantity: 2,
  refunded: false,
  remaining_balance: 0,
  special_instructions: "Vegetarian",
  split_logistics_agents: false,
  status_id: 3,
  ticket_token: "tok_9f3c7a1b",
} satisfies AdminApiAttendee;

/** The booking window a listing gets when its create body says nothing. */
const LISTING_DEFAULT_DAYS_AFTER =
  listingCatalogFields.maximumDaysAfter[1].default!();

/** The documented path of one attribute-option route: the parent's id param
 *  and the child segment both come from the resource table. */
const attributeOptionBase = (): string => {
  const entry = ADMIN_API_RESOURCES.attributes;
  const child = entry.children.options;
  return `/api/admin/${entry.path}/:${adminApiIdParam(entry.label)}/${child.path}`;
};

/** The documented path of one listing custom route. */
const listingCustom = (
  customKey: keyof typeof ADMIN_API_RESOURCES.listings.custom,
): string => {
  const custom = ADMIN_API_RESOURCES.listings.custom[customKey];
  return `/api/admin/${ADMIN_API_RESOURCES.listings.path}/${custom.subpath}`;
};

/** The five standard admin-CRUD doc entries for a resource. The paths and the
 *  id param come from the resource table, so the docs cannot disagree with
 *  the server about them. Descriptions are passed in (they carry
 *  per-resource wording, such as the holiday's owner-only note), so this
 *  shares only the method/path/request/response shape every resource
 *  repeats. `desc` is [list, get, create, update, delete]. */
const crudDocs = (c: {
  singular: string;
  entry: AdminApiResource;
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
  const base = `/api/admin/${c.entry.path}`;
  const byId = `${base}/:${adminApiIdParam(c.entry.label)}`;
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
    createBody: ADMIN_API_ATTRIBUTE_CREATE_BODY,
    deleteBody: ADMIN_API_ATTRIBUTE_DELETE_BODY,
    desc: [
      "List all attributes with their options (owner only)",
      "Get a single attribute by ID (owner only)",
      "Create an attribute (owner only)",
      "Update an attribute (owner only, all fields optional)",
      "Delete an attribute (owner only, requires name confirmation)",
    ],
    entry: ADMIN_API_RESOURCES.attributes,
    example: ADMIN_API_EXAMPLE_ATTRIBUTE,
    listResponse: { attributes: [ADMIN_API_EXAMPLE_ATTRIBUTE] },
    // A brand-new attribute has no options yet, whatever the example record
    // shows for the get/list answers.
    newRecordDefaults: { options: [] },
    singular: "attribute",
    updateBody: ADMIN_API_ATTRIBUTE_UPDATE_BODY,
  }),
  {
    description:
      "Add an option to an attribute (owner only). The answer shows the attribute with its full option list, new option last.",
    method: "POST",
    path: attributeOptionBase(),
    request: json(ADMIN_API_ATTRIBUTE_OPTION_CREATE_BODY),
    response: json({
      attribute: ADMIN_API_EXAMPLE_ATTRIBUTE_WITH_MEDIUM,
    }),
  },
  {
    description:
      "Rename an attribute option (owner only). The answer shows the attribute with its full option list.",
    method: "PUT",
    path: `${attributeOptionBase()}/:optionId`,
    request: json(ADMIN_API_ATTRIBUTE_OPTION_UPDATE_BODY),
    response: json({
      attribute: ADMIN_API_EXAMPLE_OPTION_RENAMED,
    }),
  },
  {
    description:
      "Delete an attribute option (owner only, requires the option text as confirmation).",
    method: "DELETE",
    path: `${attributeOptionBase()}/:optionId`,
    request: json(ADMIN_API_ATTRIBUTE_OPTION_DELETE_BODY),
    response: json({ status: "ok" }),
  },
  ...crudDocs({
    createBody: ADMIN_API_CREATE_BODY,
    deleteBody: ADMIN_API_DELETE_BODY,
    desc: [
      "List all listings with attendee counts",
      "Get a single listing by ID",
      "Create a new listing",
      "Update a listing (all fields optional)",
      "Delete a listing (requires name confirmation)",
    ],
    entry: ADMIN_API_RESOURCES.listings,
    example: ADMIN_API_EXAMPLE_ADMIN_LISTING,
    freshRecord: Object.fromEntries(
      BOOKING_TOTAL_FIELDS.map((field) => [field, 0]),
    ),
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
    singular: "listing",
    updateBody: ADMIN_API_UPDATE_BODY,
  }),
  {
    description: "Deactivate a listing",
    method: "POST",
    path: listingCustom("deactivate"),
    response: json({
      listing: { ...ADMIN_API_EXAMPLE_ADMIN_LISTING, active: false },
    }),
  },
  {
    description: "Reactivate a deactivated listing",
    method: "POST",
    path: listingCustom("reactivate"),
    response: json({
      listing: { ...ADMIN_API_EXAMPLE_ADMIN_LISTING, active: true },
    }),
  },
  {
    description:
      "List the attendees booked on a listing. checked_in counts the tickets on each line that the doors admitted, from 0 up to quantity.",
    method: "GET",
    path: listingCustom("attendees"),
    response: json({ attendees: [ADMIN_API_EXAMPLE_ATTENDEE] }),
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
    entry: ADMIN_API_RESOURCES.groups,
    example: ADMIN_API_EXAMPLE_GROUP,
    listResponse: { groups: [ADMIN_API_EXAMPLE_GROUP] },
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
    entry: ADMIN_API_RESOURCES.holidays,
    example: ADMIN_API_EXAMPLE_HOLIDAY,
    listResponse: { holidays: [ADMIN_API_EXAMPLE_HOLIDAY] },
    singular: "holiday",
    updateBody: ADMIN_API_HOLIDAY_UPDATE_BODY,
  }),
];
