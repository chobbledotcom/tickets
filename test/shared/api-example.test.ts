/**
 * Tests that the API example in the documentation matches the real
 * toPublicListing() output. If the shape changes, this test fails and
 * forces an update to src/shared/api-example.ts (and thus the admin guide).
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { toPublicListing } from "#routes/api/index.ts";
import {
  API_AVAILABILITY_EXAMPLE_JSON,
  API_BOOK_FREE_EXAMPLE_JSON,
  API_BOOK_PAID_EXAMPLE_JSON,
  API_BOOK_REQUEST_JSON,
  API_EXAMPLE_LISTING,
  API_EXAMPLE_PUBLIC_LISTING,
  API_LIST_EXAMPLE_JSON,
  API_SINGLE_EXAMPLE_JSON,
} from "#shared/api-example.ts";

describe("API example", () => {
  test("toPublicListing output matches the documented example", () => {
    const result = toPublicListing(
      API_EXAMPLE_LISTING,
      false,
      undefined,
      undefined,
    );
    expect(result).toEqual(API_EXAMPLE_PUBLIC_LISTING);
  });

  test("example has all PublicListing keys", () => {
    const result = toPublicListing(
      API_EXAMPLE_LISTING,
      false,
      undefined,
      undefined,
    );
    const resultKeys = Object.keys(result).sort();
    const exampleKeys = Object.keys(API_EXAMPLE_PUBLIC_LISTING).sort();
    expect(exampleKeys).toEqual(resultKeys);
  });

  test("list example JSON is valid and contains the listing", () => {
    const parsed = JSON.parse(API_LIST_EXAMPLE_JSON);
    expect(parsed.listings).toHaveLength(1);
    expect(parsed.listings[0].name).toBe(API_EXAMPLE_LISTING.name);
  });

  test("single listing example JSON includes availableDates", () => {
    const parsed = JSON.parse(API_SINGLE_EXAMPLE_JSON);
    expect(parsed.listing.name).toBe(API_EXAMPLE_LISTING.name);
    expect(Array.isArray(parsed.listing.availableDates)).toBe(true);
  });

  test("availability example JSON is valid", () => {
    const parsed = JSON.parse(API_AVAILABILITY_EXAMPLE_JSON);
    expect(parsed.available).toBe(true);
  });

  test("free booking example JSON has ticketToken and ticketUrl", () => {
    const parsed = JSON.parse(API_BOOK_FREE_EXAMPLE_JSON);
    expect(parsed.booking.ticketToken).toBeDefined();
    expect(parsed.booking.ticketUrl).toBeDefined();
    // The owed amount is surfaced so integrations can collect provider-less
    // balances; a fully-paid free booking owes nothing.
    expect(parsed.booking.amountOwed).toBe(0);
  });

  test("paid booking example JSON has checkoutUrl", () => {
    const parsed = JSON.parse(API_BOOK_PAID_EXAMPLE_JSON);
    expect(parsed.booking.checkoutUrl).toBeDefined();
  });

  test("booking request example JSON has required fields", () => {
    const parsed = JSON.parse(API_BOOK_REQUEST_JSON);
    expect(parsed.name).toBeDefined();
    expect(parsed.email).toBeDefined();
  });
});
