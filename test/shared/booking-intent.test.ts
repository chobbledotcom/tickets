import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  BookingIntentSchema,
  type BookingItem,
  BookingItemsSchema,
} from "#shared/booking-intent.ts";

/** A minimal booking line that satisfies every schema rule; spread and override
 * one field per case to probe a single boundary in isolation. Each line is
 * validated through BookingItemsSchema (the array wrapper production parses
 * against), so a single-element array exercises the per-line rules directly. */
const validItem: BookingItem = { e: 1, p: 0, q: 1 };
const accepts = (item: Record<string, unknown>) =>
  expect(v.is(BookingItemsSchema, [item])).toBe(true);
const rejects = (item: Record<string, unknown>) =>
  expect(v.is(BookingItemsSchema, [item])).toBe(false);

describe("booking line validation", () => {
  test("accepts a minimal signed line", () => {
    accepts(validItem);
  });

  test("accepts the optional edge tag with both kinds", () => {
    accepts({ ...validItem, k: "p", r: 1 });
    accepts({ ...validItem, k: "g", r: 2 });
  });

  test("the edge tag is a pair: k and r are both present or both absent", () => {
    accepts(validItem); // neither
    rejects({ ...validItem, k: "p" }); // k without r
    rejects({ ...validItem, r: 1 }); // r without k
  });

  test("the paired-edge-tag rejection carries its explanatory message", () => {
    const result = v.safeParse(BookingItemsSchema, [{ ...validItem, k: "p" }]);
    expect(result.success).toBe(false);
    expect(result.issues?.map((issue) => issue.message)).toContain(
      "edge tag k and r must both be present or both absent",
    );
  });

  test("the listing id (e) must be a positive integer", () => {
    accepts({ ...validItem, e: 1 });
    rejects({ ...validItem, e: 0 });
    rejects({ ...validItem, e: -1 });
    rejects({ ...validItem, e: 1.5 });
  });

  test("the quantity (q) must be a non-negative integer", () => {
    // A signed line may deliberately carry quantity 0 (an admin sentinel or a
    // refunded/deleted-listing placeholder), preserved rather than coerced to 1.
    accepts({ ...validItem, q: 1 });
    accepts({ ...validItem, q: 0 });
    rejects({ ...validItem, q: -1 });
    rejects({ ...validItem, q: 1.5 });
  });

  test("the line total (p) is a signed integer of minor units", () => {
    accepts({ ...validItem, p: -250 });
    accepts({ ...validItem, p: 0 });
    // p is unitPrice * quantity, both integer minor units — a fraction is corrupt.
    rejects({ ...validItem, p: 12.5 });
    rejects({ ...validItem, p: Number.POSITIVE_INFINITY });
    rejects({ ...validItem, p: Number.NaN });
  });

  test("the edge kind (k) only accepts the two literals", () => {
    accepts({ ...validItem, k: "p", r: 1 });
    accepts({ ...validItem, k: "g", r: 1 });
    rejects({ ...validItem, k: "x", r: 1 });
  });

  test("the group id (r) must be a positive integer when present", () => {
    accepts({ ...validItem, k: "p", r: 1 });
    rejects({ ...validItem, k: "p", r: 0 });
    rejects({ ...validItem, k: "p", r: 1.5 });
  });
});

describe("BookingItemsSchema", () => {
  test("accepts a non-empty array of valid lines", () => {
    expect(v.is(BookingItemsSchema, [validItem])).toBe(true);
  });

  test("rejects an empty array", () => {
    expect(v.is(BookingItemsSchema, [])).toBe(false);
  });

  test("rejects an array containing an invalid line", () => {
    expect(v.is(BookingItemsSchema, [validItem, { ...validItem, e: 0 }])).toBe(
      false,
    );
  });
});

/** The smallest booking a payment can carry. */
const validIntent = {
  address: "",
  date: null,
  email: "buyer@example.com",
  items: [validItem],
  modifiers: [],
  name: "Buyer",
  phone: "",
  special_instructions: "",
};
const acceptsIntent = (extra: Record<string, unknown>) =>
  expect(v.is(BookingIntentSchema, { ...validIntent, ...extra })).toBe(true);
const rejectsIntent = (extra: Record<string, unknown>) =>
  expect(v.is(BookingIntentSchema, { ...validIntent, ...extra })).toBe(false);

describe("what a booking a payment carries may be", () => {
  test("accepts the smallest booking", () => {
    acceptsIntent({});
  });

  // Answers are filed under a listing id. A key in any other shape matches no
  // listing, so those answers would be dropped without a word after paying.
  for (const [name, key, allowed] of [
    ["a listing id", "12", true],
    ["a listing id with a leading zero", "012", false],
    ["a name instead of an id", "listing-12", false],
    ["nothing at all", "", false],
    ["a listing id with spaces around it", " 12 ", false],
  ] as const) {
    test(`${allowed ? "accepts" : "refuses"} answers filed under ${name}`, () => {
      const check = allowed ? acceptsIntent : rejectsIntent;
      check({ listingAnswerIds: { [key]: [1] } });
      check({ listingTextAnswerIds: { [key]: [{ q: 1, s: 1 }] } });
    });
  }

  test("accepts paying off a balance with the one line it owes", () => {
    acceptsIntent({ balanceAttendeeId: 1 });
  });

  test("refuses paying off a balance that carries a second line", () => {
    // Only the balance line is settled, so a second line would be charged for
    // and then neither booked nor given back.
    rejectsIntent({ balanceAttendeeId: 1, items: [validItem, validItem] });
  });

  test("refuses a deposit nobody can read", () => {
    rejectsIntent({ reservationAmount: "half of it" });
  });

  test("accepts a deposit written as a share of the price", () => {
    acceptsIntent({ reservationAmount: "10%" });
  });
});
