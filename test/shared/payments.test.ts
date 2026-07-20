import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { ALL_SETTINGS_KEYS, settings } from "#shared/db/settings.ts";
import {
  type BookingItem,
  BookingItemsSchema,
  getActivePaymentProvider,
  isPaymentStatus,
} from "#shared/payments.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { useDebugLogSpy } from "#test-utils/debug-log.ts";

/** A minimal booking line that satisfies every schema rule; spread and override
 * one field per case to probe a single boundary in isolation. Each line is
 * validated through BookingItemsSchema (the array wrapper production parses
 * against), so a single-element array exercises the per-line rules directly. */
const validItem: BookingItem = { e: 1, p: 0, q: 1 };
const accepts = (item: Record<string, unknown>) =>
  expect(v.is(BookingItemsSchema, [item])).toBe(true);
const rejects = (item: Record<string, unknown>) =>
  expect(v.is(BookingItemsSchema, [item])).toBe(false);

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

describeWithEnv("getActivePaymentProvider", { db: true }, () => {
  const debugSpy = useDebugLogSpy();
  const debugLogged = (needle: string): boolean =>
    debugSpy().calls.some((call) => String(call.args[0]).includes(needle));

  test("returns null when no provider is configured", async () => {
    expect(await getActivePaymentProvider()).toBeNull();
    expect(
      debugLogged("[Payment] No payment provider configured in settings"),
    ).toBe(true);
  });

  test("logs the provider it resolves under the Payment category", async () => {
    await settings.update.paymentProvider("stripe");
    await getActivePaymentProvider();
    expect(debugLogged("[Payment] Resolving payment provider: stripe")).toBe(
      true,
    );
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
