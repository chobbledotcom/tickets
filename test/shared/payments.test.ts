import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { ALL_SETTINGS_KEYS, settings } from "#shared/db/settings.ts";
import {
  type BookingItem,
  BookingItemSchema,
  BookingItemsSchema,
  getActivePaymentProvider,
  isPaymentStatus,
} from "#shared/payments.ts";
import { describeWithEnv } from "#test-utils";

/** A minimal booking line that satisfies every schema rule; spread and override
 * one field per case to probe a single boundary in isolation. */
const validItem: BookingItem = { e: 1, p: 0, q: 0 };
const accepts = (item: Record<string, unknown>) =>
  expect(v.is(BookingItemSchema, item)).toBe(true);
const rejects = (item: Record<string, unknown>) =>
  expect(v.is(BookingItemSchema, item)).toBe(false);

describe("isPaymentStatus", () => {
  for (const status of ["paid", "unpaid", "no_payment_required", "failed"]) {
    test(`accepts ${JSON.stringify(status)}`, () => {
      expect(isPaymentStatus(status)).toBe(true);
    });
  }
  for (const other of ["", "PAID", "refunded", "pending", "paid "]) {
    test(`rejects ${JSON.stringify(other)}`, () => {
      expect(isPaymentStatus(other)).toBe(false);
    });
  }
});

describe("BookingItemSchema", () => {
  test("accepts a minimal signed line", () => {
    accepts(validItem);
  });

  test("accepts the optional edge tag with both kinds", () => {
    accepts({ ...validItem, k: "p", r: 1 });
    accepts({ ...validItem, k: "g", r: 2 });
  });

  test("the listing id (e) must be a positive integer", () => {
    accepts({ ...validItem, e: 1 });
    rejects({ ...validItem, e: 0 });
    rejects({ ...validItem, e: -1 });
    rejects({ ...validItem, e: 1.5 });
  });

  test("the quantity (q) must be a non-negative integer", () => {
    accepts({ ...validItem, q: 0 });
    rejects({ ...validItem, q: -1 });
    rejects({ ...validItem, q: 1.5 });
  });

  test("the unit price (p) may be signed but must be finite", () => {
    accepts({ ...validItem, p: -250 });
    accepts({ ...validItem, p: 12.5 });
    rejects({ ...validItem, p: Number.POSITIVE_INFINITY });
    rejects({ ...validItem, p: Number.NaN });
  });

  test("the edge kind (k) only accepts the two literals", () => {
    accepts({ ...validItem, k: "p" });
    accepts({ ...validItem, k: "g" });
    rejects({ ...validItem, k: "x" });
  });

  test("the group id (r) must be a positive integer when present", () => {
    accepts({ ...validItem, r: 1 });
    rejects({ ...validItem, r: 0 });
    rejects({ ...validItem, r: 1.5 });
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

describeWithEnv("getActivePaymentProvider", { db: true }, () => {
  test("returns null when no provider is configured", async () => {
    expect(await getActivePaymentProvider()).toBeNull();
  });

  test("returns null for a provider type the module doesn't recognise", async () => {
    // setRaw bypasses the typed API; reload so the snapshot reflects the raw value
    await settings.setRaw("payment_provider", "unknown_provider");
    settings.invalidateCache();
    await settings.loadKeys(ALL_SETTINGS_KEYS);
    expect(await getActivePaymentProvider()).toBeNull();
  });

  test("returns the stripe provider when provider is set to stripe", async () => {
    await settings.update.paymentProvider("stripe");
    const provider = await getActivePaymentProvider();
    expect(provider?.type).toBe("stripe");
  });

  test("returns the square provider when provider is set to square", async () => {
    await settings.update.paymentProvider("square");
    const provider = await getActivePaymentProvider();
    expect(provider?.type).toBe("square");
  });

  test("returns the sumup provider when provider is set to sumup", async () => {
    await settings.update.paymentProvider("sumup");
    const provider = await getActivePaymentProvider();
    expect(provider?.type).toBe("sumup");
  });
});
