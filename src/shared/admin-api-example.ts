/**
 * Example admin API responses for documentation.
 *
 * These constants are rendered on the admin API docs page. A test validates
 * that calling toAdminListing() with the same inputs produces matching
 * output, so a shape change will break the test and force an update.
 */

import { toAdminListing } from "#routes/admin/api.ts";
import type { AdminApiAttendee } from "#routes/admin/api-attendees.ts";
import type {
  CreateGroupBody,
  UpdateGroupBody,
} from "#routes/admin/api-groups.ts";
import type {
  CreateListingBody,
  UpdateListingBody,
} from "#routes/admin/api-listing-body.ts";
import {
  ADMIN_API_RESOURCES,
  type AdminApiAttendeeStatus,
  type AdminApiCreateAttendeeStatusBody,
  type AdminApiHoliday,
} from "#shared/admin-api-resources.ts";
import { API_EXAMPLE_LISTING } from "#shared/api-example.ts";
import { type SnakeCased, snakeCaseKeys } from "#shared/column-names.ts";
import { VALID_DAY_NAMES } from "#shared/day-names.ts";
import { withoutKeys } from "#shared/fp-records.ts";
import { ATTENDEE_FEATURE_KEYS } from "#shared/records/attendee-answer-keys.ts";
import { LISTING_FIELDS } from "#shared/records/listing-fields.ts";
import type { ApiBody } from "#shared/rest/api-body-fields.ts";
import type { DeleteBody } from "#shared/rest/crud-parsers.ts";
import {
  featureClosedKeys,
  fieldOfKey,
  type WriteAccess,
} from "#shared/rest/field-specs.ts";
import type { AdminListing, Group } from "#types";
import { attributeDocs } from "./admin-api-example/attributes.ts";
import {
  crudDocsFor,
  type DocsView,
  docKeysOf,
  type EndpointDoc,
  json,
  recordDocsFor,
  shownFor,
} from "./admin-api-example/endpoint-doc.ts";
import { EXTERNAL_SOURCE_ENDPOINTS } from "./admin-api-example/external-sources.ts";
import { IMAGE_ENDPOINTS } from "./admin-api-example/images.ts";
import { QUESTION_ENDPOINTS } from "./admin-api-example/questions.ts";
import { SITE_PAGE_ENDPOINTS } from "./admin-api-example/site-pages.ts";

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
export const ADMIN_API_EXAMPLE_ADMIN_LISTING: SnakeCased<AdminListing> & {
  attribute_option_ids: number[];
  group_ids: number[];
} = {
  ...snakeCaseKeys(toAdminListing(API_EXAMPLE_LISTING)),
  attribute_option_ids: [],
  group_ids: [],
};

/** Example create request body */
const ADMIN_API_CREATE_BODY = {
  can_pay_more: true,
  closes_at: "2025-08-19T17:00:00.000Z",
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
  scan_checks_in_all_listings: false,
  show_hidden_listings: true,
  slug: "summer-series",
  terms_and_conditions: "",
} satisfies SnakeCased<Omit<Group, "slugIndex">>;

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

const GROUP_DOCS = {
  createBody: ADMIN_API_GROUP_CREATE_BODY,
  deleteBody: ADMIN_API_GROUP_DELETE_BODY,
  example: ADMIN_API_EXAMPLE_GROUP,
  updateBody: ADMIN_API_GROUP_UPDATE_BODY,
};

// =============================================================================
// Holiday examples (owner only)
// =============================================================================

/** Example holiday response */
const ADMIN_API_EXAMPLE_HOLIDAY = {
  end_date: "2025-12-26",
  id: 5,
  name: "Christmas",
  start_date: "2025-12-25",
} satisfies AdminApiHoliday;

const ADMIN_API_HOLIDAY_CREATE_BODY = {
  end_date: "2025-12-26",
  name: "Christmas",
  start_date: "2025-12-25",
} satisfies ApiBody<typeof ADMIN_API_RESOURCES.holidays.createBodySchema>;

const ADMIN_API_HOLIDAY_UPDATE_BODY = {
  name: "Christmas Break",
} satisfies ApiBody<typeof ADMIN_API_RESOURCES.holidays.updateBodySchema>;

const ADMIN_API_HOLIDAY_DELETE_BODY = {
  confirm_identifier: "Christmas",
} satisfies DeleteBody;

const HOLIDAY_DOCS = {
  createBody: ADMIN_API_HOLIDAY_CREATE_BODY,
  deleteBody: ADMIN_API_HOLIDAY_DELETE_BODY,
  example: ADMIN_API_EXAMPLE_HOLIDAY,
  updateBody: ADMIN_API_HOLIDAY_UPDATE_BODY,
};

// =============================================================================
// Attendee-status examples (owner only)
// =============================================================================

/** Example status response: the seeded default every new site starts with. */
const ADMIN_API_EXAMPLE_ATTENDEE_STATUS = {
  id: 1,
  is_paid_default: true,
  is_public_default: true,
  is_reservation: false,
  name: "Confirmed",
  reservation_amount: "0",
} satisfies AdminApiAttendeeStatus;

/** The create body a caller copies: a reservation the caller adds beside the
 *  seeded default, with a deposit of a quarter of the total. */
const ADMIN_API_ATTENDEE_STATUS_CREATE_BODY = {
  is_paid_default: false,
  is_public_default: false,
  is_reservation: true,
  name: "Reserved",
  reservation_amount: "25%",
} satisfies AdminApiCreateAttendeeStatusBody;

const ADMIN_API_ATTENDEE_STATUS_UPDATE_BODY = {
  name: "Reserved seat",
} satisfies Partial<AdminApiCreateAttendeeStatusBody>;

const ADMIN_API_ATTENDEE_STATUS_DELETE_BODY = {
  confirm_identifier: "Reserved",
} satisfies DeleteBody;

const ATTENDEE_STATUS_DOCS = {
  createBody: ADMIN_API_ATTENDEE_STATUS_CREATE_BODY,
  deleteBody: ADMIN_API_ATTENDEE_STATUS_DELETE_BODY,
  example: ADMIN_API_EXAMPLE_ATTENDEE_STATUS,
  updateBody: ADMIN_API_ATTENDEE_STATUS_UPDATE_BODY,
};

/** The create body a caller copies: one booking line on a standard listing,
 * with the attendee's contact fields and the status by name. The line carries
 * an agreed per-unit `price` (minor units), the body records a `payment`
 * already received, and a named `adjustment` bills the delivery. The buyer's
 * `answers` carry one entry per question: a choice answer names its answerId,
 * a free-text answer names its freeText. All amounts are minor units. An
 * optional `created` stamps the business time the booking happened, for a
 * phone booking taken on an earlier day. When absent, the booking is stamped
 * now. */
const ADMIN_API_ATTENDEE_CREATE_BODY = {
  address: "12 Main Street, Springfield",
  adjustments: [{ amount: 250, description: "Delivery" }],
  answers: [
    { answerId: 3, questionId: 2 },
    { freeText: "Vegetarian", questionId: 5 },
  ],
  created: "2026-06-01T09:00:00.000Z",
  email: "jane@example.com",
  lines: [{ listingId: 4, price: 4500, quantity: 2 }],
  name: "Jane Doe",
  payments: [{ amount: 9000 }],
  phone: "+1 555 0123",
  special_instructions: "Vegetarian",
  status: "Confirmed",
};

/** The body an attendee update carries: every field is optional, and a field
 * the body leaves out keeps its stored value. Payments and adjustments are the
 * complete lists, so the example repeats the create's payment and adds one. */
const ADMIN_API_ATTENDEE_UPDATE_BODY = {
  adjustments: [{ amount: 250, description: "Delivery" }],
  payments: [{ amount: 9000 }, { amount: 1500 }],
  phone: "+1 555 0199",
  status: "Paid",
};

/** Example attendee booking row, exactly as the attendees endpoint answers
 * with it: the decrypted roster row minus the sealed PII blob and its blind
 * index. A standard listing holds no booking date, so both span fields are
 * null. A daily listing carries its booked day number instead. */
const ADMIN_API_EXAMPLE_ATTENDEE = {
  address: "12 Main Street, Springfield",
  attachment_downloads: 0,
  // A count of the line's admitted tickets, 0 up to quantity: one of two in.
  checked_in: 1,
  created: "2026-06-01T09:00:00.000Z",
  date: null,
  email: "jane@example.com",
  email_owed: 0,
  email_pending: 0,
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
  webhooks_pending: 0,
} satisfies AdminApiAttendee;

/** The booking window a listing gets when its create body says nothing. */
const LISTING_DEFAULT_DAYS_AFTER = fieldOfKey(
  LISTING_FIELDS,
  "maximumDaysAfter",
).default;

/** The documented path of one listing custom route. */
const listingCustom = (
  customKey: keyof typeof ADMIN_API_RESOURCES.listings.custom,
): string => {
  const custom = ADMIN_API_RESOURCES.listings.custom[customKey];
  return `/api/admin/${ADMIN_API_RESOURCES.listings.path}/${custom.subpath}`;
};

/** The example attendee as one site answers with it: without each key whose
 *  feature is off. */
const attendeeExample = (access: WriteAccess): Record<string, unknown> =>
  withoutKeys(
    new Set(featureClosedKeys(ATTENDEE_FEATURE_KEYS, access.features)),
  )(ADMIN_API_EXAMPLE_ATTENDEE);

/** The documented listing routes. Each listing answer leaves out the keys
 *  whose feature is off, as the server does. */
const listingDocs = (access: WriteAccess): EndpointDoc[] => {
  const crudDocs = crudDocsFor(access);
  const { hidden } = docKeysOf(ADMIN_API_RESOURCES.listings, access);
  const listing = withoutKeys(hidden)(ADMIN_API_EXAMPLE_ADMIN_LISTING);
  return [
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
      listExtras: { admin_level: "owner", features: access.features },
      // What a listing gets when the create body does not say. Both come from
      // the stored column defaults, so the documentation cannot drift from them.
      newRecordDefaults: {
        bookable_days: [...VALID_DAY_NAMES],
        maximum_days_after: LISTING_DEFAULT_DAYS_AFTER,
      },
      updateBody: ADMIN_API_UPDATE_BODY,
    }),
    {
      description: "Deactivate a listing",
      method: "POST",
      path: listingCustom("deactivate"),
      response: json({
        listing: { ...listing, active: false },
      }),
    },
    {
      description: "Reactivate a deactivated listing",
      method: "POST",
      path: listingCustom("reactivate"),
      response: json({
        listing: { ...listing, active: true },
      }),
    },
    {
      description:
        "List the attendees booked on a listing. checked_in counts the tickets on each line that the doors admitted, from 0 up to quantity.",
      method: "GET",
      path: listingCustom("attendees"),
      response: json({ attendees: [attendeeExample(access)] }),
    },
  ];
};

/** Every documented admin route, as one viewer of one site sees the docs.
 *  A resource whose feature is off has no routes here. */
export const adminApiEndpoints = (view: DocsView): EndpointDoc[] => {
  const { access } = view;
  const shown = shownFor(view);
  const recordDocs = recordDocsFor(access);
  return [
    ...shown(ADMIN_API_RESOURCES.attributes, attributeDocs(access)),
    ...listingDocs(access),
    ...recordDocs("groups", "a group", GROUP_DOCS),
    ...recordDocs("holidays", "a holiday", HOLIDAY_DOCS, "owner"),
    ...recordDocs(
      "attendee-statuses",
      "an attendee status",
      ATTENDEE_STATUS_DOCS,
      "owner",
    ),
    {
      description:
        "Create a booking. The answer is the stored attendee row. The body can carry the buyer's answers to the booking's questions: { questionId, answerId } for a choice, or { questionId, freeText } for free text. The create never emails the buyer; a caller-chosen ticketToken makes a retry a no-op. An optional created stamps the business time the booking happened.",
      method: "POST",
      path: "/api/admin/attendees",
      request: json(ADMIN_API_ATTENDEE_CREATE_BODY),
      response: json({ attendee: attendeeExample(access) }),
    },
    {
      description:
        "Update a booking. Every field is optional, and a field the body leaves out keeps its stored value. lines is the complete set of booking lines, and a stored line that no line names is removed. payments and adjustments are the complete lists, in the create's shape: a receipt that is already stored adds nothing, and a receipt already stored as different money is refused. A line change moves no money. The ticketToken and created fields name the booking, so an update refuses both.",
      method: "PUT",
      path: "/api/admin/attendees/:attendeeId",
      request: json(ADMIN_API_ATTENDEE_UPDATE_BODY),
      response: json({ attendee: attendeeExample(access) }),
    },
    ...shown(ADMIN_API_RESOURCES.questions, QUESTION_ENDPOINTS),
    ...shown(ADMIN_API_RESOURCES["site-pages"], SITE_PAGE_ENDPOINTS),
    ...shown(
      ADMIN_API_RESOURCES["external-sources"],
      EXTERNAL_SOURCE_ENDPOINTS,
    ),
    ...IMAGE_ENDPOINTS,
  ];
};
