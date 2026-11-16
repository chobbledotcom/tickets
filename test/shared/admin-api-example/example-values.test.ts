/**
 * The values of the documented examples that no schema pins: an id, a count,
 * or a switch that a caller reads and copies.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ADMIN_API_ENDPOINTS } from "#shared/admin-api-example.ts";
import { documentedBodies } from "./helpers.ts";

const bodiesOf = documentedBodies(ADMIN_API_ENDPOINTS);

/** The value at a path of keys inside a parsed body. */
const valueAt = (body: unknown, path: readonly (number | string)[]): unknown =>
  path.reduce<unknown>(
    (node, key) => (node as Record<number | string, unknown>)[key],
    body,
  );

const STATUS = {
  id: 1,
  is_paid_default: true,
  is_public_default: true,
  is_reservation: false,
  name: "Confirmed",
  reservation_amount: "0",
};

const EASY = { attribute_id: 6, id: 11, sort_order: 0, text: "Easy" };
const HARD = { attribute_id: 6, id: 12, sort_order: 1, text: "Hard" };
const ATTRIBUTE = {
  id: 6,
  name: "Difficulty",
  options: [EASY, HARD],
  sort_order: 2,
};

describe("documented example values", () => {
  test("the listing create asks for at least one ticket in a booking", () => {
    const { request } = bodiesOf("POST", "/api/admin/listings");

    expect(valueAt(request, ["min_quantity"])).toBe(1);
  });

  test("the example group checks in only its own listing at a scan", () => {
    const { response } = bodiesOf("GET", "/api/admin/groups/:groupId");

    expect(valueAt(response, ["group", "scan_checks_in_all_listings"])).toBe(
      false,
    );
  });

  test("the example status is the seeded default of a new site", () => {
    expect(bodiesOf("GET", "/api/admin/attendee-statuses").response).toEqual({
      "attendee-statuses": [STATUS],
    });
  });

  test("the status create adds a reservation with a deposit", () => {
    const created = {
      is_paid_default: false,
      is_public_default: false,
      is_reservation: true,
      name: "Reserved",
      reservation_amount: "25%",
    };

    expect(bodiesOf("POST", "/api/admin/attendee-statuses")).toEqual({
      request: created,
      response: { status: { ...STATUS, ...created } },
    });
  });

  test("the attendee create carries a line, a payment, an adjustment, and two answers", () => {
    expect(bodiesOf("POST", "/api/admin/attendees").request).toEqual({
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
    });
  });

  test("the example attendee has no notification left to send", () => {
    const { response } = bodiesOf(
      "GET",
      "/api/admin/listings/:listingId/attendees",
    );
    const counts = ["email_owed", "email_pending", "webhooks_pending"].map(
      (key) => valueAt(response, ["attendees", 0, key]),
    );

    expect(counts).toEqual([0, 0, 0]);
  });

  test("the example attribute holds its two options in display order", () => {
    expect(
      bodiesOf("GET", "/api/admin/attributes/:attributeId").response,
    ).toEqual({ attribute: ATTRIBUTE });
  });

  test("an added option joins the attribute last", () => {
    const { response } = bodiesOf(
      "POST",
      "/api/admin/attributes/:attributeId/options",
    );

    expect(response).toEqual({
      attribute: {
        ...ATTRIBUTE,
        options: [
          EASY,
          HARD,
          { attribute_id: 6, id: 13, sort_order: 2, text: "Medium" },
        ],
      },
    });
  });
});
