/**
 * Tests that the API example in the documentation matches the real
 * toPublicEvent() output. If the shape changes, this test fails and
 * forces an update to src/lib/api-example.ts (and thus the admin guide).
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  API_AVAILABILITY_EXAMPLE_JSON,
  API_BOOK_FREE_EXAMPLE_JSON,
  API_BOOK_PAID_EXAMPLE_JSON,
  API_BOOK_REQUEST_JSON,
  API_EXAMPLE_EVENT,
  API_EXAMPLE_PUBLIC_EVENT,
  API_LIST_EXAMPLE_JSON,
  API_SINGLE_EXAMPLE_JSON,
} from "#lib/api-example.ts";
import { toPublicEvent } from "#routes/api.ts";

describe("API example", () => {
  test("toPublicEvent output matches the documented example", () => {
    const result = toPublicEvent(API_EXAMPLE_EVENT);
    expect(result).toEqual(API_EXAMPLE_PUBLIC_EVENT);
  });

  test("example has all PublicEvent keys", () => {
    const result = toPublicEvent(API_EXAMPLE_EVENT);
    const resultKeys = Object.keys(result).sort();
    const exampleKeys = Object.keys(API_EXAMPLE_PUBLIC_EVENT).sort();
    expect(exampleKeys).toEqual(resultKeys);
  });

  test("list example JSON is valid and contains the event", () => {
    const parsed = JSON.parse(API_LIST_EXAMPLE_JSON);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0].name).toBe(API_EXAMPLE_EVENT.name);
  });

  test("single event example JSON includes availableDates", () => {
    const parsed = JSON.parse(API_SINGLE_EXAMPLE_JSON);
    expect(parsed.event.name).toBe(API_EXAMPLE_EVENT.name);
    expect(Array.isArray(parsed.event.availableDates)).toBe(true);
  });

  test("availability example JSON is valid", () => {
    const parsed = JSON.parse(API_AVAILABILITY_EXAMPLE_JSON);
    expect(parsed.available).toBe(true);
  });

  test("free booking example JSON has ticketToken and ticketUrl", () => {
    const parsed = JSON.parse(API_BOOK_FREE_EXAMPLE_JSON);
    expect(parsed.ticketToken).toBeDefined();
    expect(parsed.ticketUrl).toBeDefined();
  });

  test("paid booking example JSON has checkoutUrl", () => {
    const parsed = JSON.parse(API_BOOK_PAID_EXAMPLE_JSON);
    expect(parsed.checkoutUrl).toBeDefined();
  });

  test("booking request example JSON has required fields", () => {
    const parsed = JSON.parse(API_BOOK_REQUEST_JSON);
    expect(parsed.name).toBeDefined();
    expect(parsed.email).toBeDefined();
  });
});
