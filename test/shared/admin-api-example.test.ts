/**
 * The admin API docs page publishes an example listing. These check it against
 * a hand-written shape, so a change to the real conversion cannot quietly take
 * the documented example with it.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { toAdminListing } from "#routes/admin/api.ts";
import {
  ADMIN_API_EXAMPLE_ADMIN_LISTING,
  BOOKING_TOTAL_FIELDS,
} from "#shared/admin-api-example.ts";
import { API_EXAMPLE_LISTING } from "#shared/api-example.ts";
import { AdminListingSchema } from "#test-utils/api-schemas.ts";
import {
  ADMIN_API_ENDPOINTS,
  documented,
} from "./admin-api-example/helpers.ts";

describe("admin API example", () => {
  test("the documented example has every admin listing field", () => {
    expect(() =>
      v.parse(AdminListingSchema, ADMIN_API_EXAMPLE_ADMIN_LISTING),
    ).not.toThrow();
  });

  test("an internal field leaking into a response is refused", () => {
    expect(() =>
      v.parse(AdminListingSchema, {
        ...ADMIN_API_EXAMPLE_ADMIN_LISTING,
        slug_index: "leaked",
      }),
    ).toThrow();
  });

  test("a missing field is refused", () => {
    const { name: _, ...withoutName } = ADMIN_API_EXAMPLE_ADMIN_LISTING;

    expect(() => v.parse(AdminListingSchema, withoutName)).toThrow();
  });

  test("a field of the wrong type is refused", () => {
    expect(() =>
      v.parse(AdminListingSchema, {
        ...ADMIN_API_EXAMPLE_ADMIN_LISTING,
        id: "1",
      }),
    ).toThrow();
  });

  test("the conversion drops the internal slug index", () => {
    expect(toAdminListing(API_EXAMPLE_LISTING)).not.toHaveProperty("slugIndex");
  });

  test("the conversion keeps every other listing field as it was", () => {
    const { slugIndex: _, ...expected } = API_EXAMPLE_LISTING;

    expect(toAdminListing(API_EXAMPLE_LISTING)).toEqual(expected);
  });

  test("the documented example says which groups the listing is in", () => {
    expect(ADMIN_API_EXAMPLE_ADMIN_LISTING.group_ids).toEqual([]);
  });
});

/** The documented endpoint for a method and path. */
const endpointOf = (method: string, path: string) =>
  documented(ADMIN_API_ENDPOINTS, method, path);

/** The parsed request body of a documented endpoint. */
const requestOf = (method: string, path: string) => {
  const { request } = endpointOf(method, path);
  if (request === undefined) throw new Error(`${method} ${path} has no body`);
  return JSON.parse(request);
};

/** The parsed answer of a documented endpoint. */
const responseOf = (method: string, path: string) =>
  JSON.parse(endpointOf(method, path).response);

/** The description of each documented route, in the order given. */
const descriptionsOf = (routes: [string, string][]): string[] =>
  routes.map(([method, path]) => endpointOf(method, path).description);

/** The five routes of one record: list, get, create, update, delete. */
const crudRoutes = (base: string, byId: string): [string, string][] => [
  ["GET", base],
  ["GET", byId],
  ["POST", base],
  ["PUT", byId],
  ["DELETE", byId],
];

/** The documented values of one record: its example answer, its three request
 * bodies, and the words that describe its five routes. */
type RecordCase = {
  base: string;
  byId: string;
  create: object;
  deleteBody: object;
  descriptions: string[];
  example: object;
  singular: string;
  title: string;
  update: object;
};

const RECORD_CASES: RecordCase[] = [
  {
    base: "/api/admin/groups",
    byId: "/api/admin/groups/:groupId",
    create: {
      description: "Workshops running through the summer.",
      max_attendees: 50,
      name: "Summer Series",
    },
    deleteBody: { confirm_identifier: "Summer Series" },
    descriptions: [
      "List all groups",
      "Get a group by ID",
      "Create a group",
      "Update a group (all fields optional)",
      "Delete a group (requires name confirmation)",
    ],
    example: {
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
    },
    singular: "group",
    title: "group",
    update: { hidden: true, name: "Summer Series (Updated)" },
  },
  {
    base: "/api/admin/holidays",
    byId: "/api/admin/holidays/:holidayId",
    create: {
      end_date: "2025-12-26",
      name: "Christmas",
      start_date: "2025-12-25",
    },
    deleteBody: { confirm_identifier: "Christmas" },
    descriptions: [
      "List all holidays (owner only)",
      "Get a holiday by ID (owner only)",
      "Create a holiday (owner only)",
      "Update a holiday (owner only, all fields optional)",
      "Delete a holiday (owner only, requires name confirmation)",
    ],
    example: {
      end_date: "2025-12-26",
      id: 5,
      name: "Christmas",
      start_date: "2025-12-25",
    },
    singular: "holiday",
    title: "holiday",
    update: { name: "Christmas Break" },
  },
  {
    base: "/api/admin/attendee-statuses",
    byId: "/api/admin/attendee-statuses/:statusId",
    create: {
      is_paid_default: false,
      is_public_default: false,
      is_reservation: true,
      name: "Reserved",
      reservation_amount: "25%",
    },
    deleteBody: { confirm_identifier: "Reserved" },
    descriptions: [
      "List all attendee statuses (owner only)",
      "Get an attendee status by ID (owner only)",
      "Create an attendee status (owner only)",
      "Update an attendee status (owner only, all fields optional)",
      "Delete an attendee status (owner only, requires name confirmation)",
    ],
    example: {
      id: 1,
      is_paid_default: true,
      is_public_default: true,
      is_reservation: false,
      name: "Confirmed",
      reservation_amount: "0",
    },
    singular: "status",
    title: "attendee status",
    update: { name: "Reserved seat" },
  },
];

describe("documented record examples", () => {
  for (const record of RECORD_CASES) {
    const listKey = record.base.replace("/api/admin/", "");

    test(`the ${record.title} example record is pinned`, () => {
      expect(responseOf("GET", record.byId)[record.singular]).toEqual(
        record.example,
      );
      expect(responseOf("GET", record.base)[listKey]).toEqual([record.example]);
    });

    test(`the ${record.title} request bodies are pinned`, () => {
      expect(requestOf("POST", record.base)).toEqual(record.create);
      expect(requestOf("PUT", record.byId)).toEqual(record.update);
      expect(requestOf("DELETE", record.byId)).toEqual(record.deleteBody);
    });

    test(`the ${record.title} routes are described in words`, () => {
      expect(descriptionsOf(crudRoutes(record.base, record.byId))).toEqual(
        record.descriptions,
      );
    });
  }
});

describe("documented listing examples", () => {
  const base = "/api/admin/listings";
  const byId = "/api/admin/listings/:listingId";

  test("the running totals of a new listing are listed", () => {
    expect(BOOKING_TOTAL_FIELDS).toEqual([
      "attendee_count",
      "cost",
      "income",
      "profit",
      "tickets_count",
    ]);
  });

  test("the listing request bodies are pinned", () => {
    expect(requestOf("POST", base)).toEqual({
      can_pay_more: true,
      closes_at: "2025-08-19T17:00:00.000Z",
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
    });
    expect(requestOf("PUT", byId)).toEqual({
      location: "Main Hall",
      max_attendees: 30,
      name: "Summer Workshop (Updated)",
    });
    expect(requestOf("DELETE", byId)).toEqual({
      confirm_identifier: "Summer Workshop",
    });
  });

  test("a created listing has nothing booked against it yet", () => {
    expect(responseOf("POST", base).listing).toMatchObject({
      attendee_count: 0,
      cost: 0,
      income: 0,
      profit: 0,
      tickets_count: 0,
    });
  });

  test("the listing list is answered for an owner", () => {
    expect(responseOf("GET", base).admin_level).toBe("owner");
  });

  test("the listing routes are described in words", () => {
    expect(descriptionsOf(crudRoutes(base, byId))).toEqual([
      "List all listings with attendee counts",
      "Get a single listing by ID",
      "Create a new listing",
      "Update a listing (all fields optional)",
      "Delete a listing (requires name confirmation)",
    ]);
  });

  test("the listing switches are described and answer their new state", () => {
    const deactivate = endpointOf("POST", `${byId}/deactivate`);
    const reactivate = endpointOf("POST", `${byId}/reactivate`);

    expect(deactivate.description).toBe("Deactivate a listing");
    expect(reactivate.description).toBe("Reactivate a deactivated listing");
    expect(JSON.parse(deactivate.response).listing.active).toBe(false);
    expect(JSON.parse(reactivate.response).listing.active).toBe(true);
  });

  test("the listing attendees route says what checked_in counts", () => {
    expect(endpointOf("GET", `${byId}/attendees`).description).toBe(
      "List the attendees booked on a listing. checked_in counts the tickets on each line that the doors admitted, from 0 up to quantity.",
    );
  });
});

describe("documented attendee examples", () => {
  /* jscpd:ignore-start -- static data, not code */
  const ATTENDEE = {
    address: "12 Main Street, Springfield",
    attachment_downloads: 0,
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
  };
  const CREATE_BODY = {
    address: "12 Main Street, Springfield",
    adjustments: [{ amount: 250, description: "Delivery", taxable: true }],
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
  /* jscpd:ignore-end */
  const create = "/api/admin/attendees";
  const update = "/api/admin/attendees/:attendeeId";

  test("the attendee row is pinned in every answer that shows it", () => {
    expect(
      responseOf("GET", "/api/admin/listings/:listingId/attendees").attendees,
    ).toEqual([ATTENDEE]);
    expect(responseOf("POST", create).attendee).toEqual(ATTENDEE);
    expect(responseOf("PUT", update).attendee).toEqual(ATTENDEE);
  });

  test("the attendee request bodies are pinned", () => {
    expect(requestOf("POST", create)).toEqual(CREATE_BODY);
    expect(requestOf("PUT", update)).toEqual({
      adjustments: [{ amount: 250, description: "Delivery" }],
      payments: [{ amount: 9000 }, { amount: 1500 }],
      phone: "+1 555 0199",
      status: "Paid",
    });
  });

  test("the attendee write routes are described in words", () => {
    const routes: [string, string][] = [
      ["POST", create],
      ["PUT", update],
    ];

    expect(descriptionsOf(routes)).toEqual([
      "Create a booking. The answer is the stored attendee row. The body can carry the buyer's answers to the booking's questions: { questionId, answerId } for a choice, or { questionId, freeText } for free text. The create never emails the buyer; a caller-chosen ticketToken makes a retry a no-op. Set notifications to false for an imported booking: it owes no email and fires no webhook. When notifications is absent, the booking owes its email and fires the listing's webhooks. An optional created stamps the business time the booking happened. An adjustment with taxable: true is a charge that the tax counts, such as delivery. An update refuses taxable.",
      "Update a booking. Every field is optional, and a field the body leaves out keeps its stored value. lines is the complete set of booking lines, and a stored line that no line names is removed. payments and adjustments are the complete lists, in the create's shape: a receipt that is already stored adds nothing, and a receipt already stored as different money is refused. A line change moves no money. The ticketToken and created fields name the booking, so an update refuses both.",
    ]);
  });
});
