import { describe, expect, test } from "#test-compat";
import {
  buildMultiIntentMetadata,
  buildSingleIntentMetadata,
  createWithClient,
  extractSessionMetadata,
  hasRequiredSessionMetadata,
  safeAsync,
  serializeMultiItems,
  toCheckoutResult,
} from "#lib/payment-helpers.ts";
import { ErrorCode } from "#lib/logger.ts";

describe("payment-helpers", () => {
  describe("safeAsync", () => {
    test("returns the resolved value on success", async () => {
      const result = await safeAsync(
        () => Promise.resolve(42),
        ErrorCode.PAYMENT_CHECKOUT,
      );
      expect(result).toBe(42);
    });

    test("returns null on rejection", async () => {
      const result = await safeAsync(
        () => Promise.reject(new Error("boom")),
        ErrorCode.PAYMENT_CHECKOUT,
      );
      expect(result).toBeNull();
    });

    test("returns null when function throws a non-Error", async () => {
      const result = await safeAsync(
        () => Promise.reject("string error"),
        ErrorCode.PAYMENT_CHECKOUT,
      );
      expect(result).toBeNull();
    });

    test("returns complex objects on success", async () => {
      const obj = { id: "sess_1", url: "https://pay.example.com" };
      const result = await safeAsync(
        () => Promise.resolve(obj),
        ErrorCode.PAYMENT_SESSION,
      );
      expect(result).toEqual(obj);
    });
  });

  describe("createWithClient", () => {
    test("returns null when getClient resolves to null", async () => {
      const withClient = createWithClient(() => Promise.resolve(null));
      const result = await withClient(
        () => Promise.resolve("value"),
        ErrorCode.PAYMENT_CHECKOUT,
      );
      expect(result).toBeNull();
    });

    test("passes client to operation and returns result", async () => {
      const withClient = createWithClient(() =>
        Promise.resolve({ token: "abc" }),
      );
      const result = await withClient(
        (client) => Promise.resolve(`got-${client.token}`),
        ErrorCode.PAYMENT_CHECKOUT,
      );
      expect(result).toBe("got-abc");
    });

    test("returns null when operation throws", async () => {
      const withClient = createWithClient(() =>
        Promise.resolve({ token: "abc" }),
      );
      const result = await withClient(
        (_client) => Promise.reject(new Error("op failed")),
        ErrorCode.PAYMENT_CHECKOUT,
      );
      expect(result).toBeNull();
    });

  });

  describe("serializeMultiItems", () => {
    test("serializes single item to compact JSON", () => {
      const items = [{ eventId: 1, quantity: 2, unitPrice: 1000, slug: "evt", name: "Evt" }];
      const result = serializeMultiItems(items);
      expect(result).toBe(JSON.stringify([{ e: 1, q: 2 }]));
    });

    test("serializes multiple items preserving order", () => {
      const items = [
        { eventId: 10, quantity: 1, unitPrice: 500, slug: "a", name: "A" },
        { eventId: 20, quantity: 3, unitPrice: 700, slug: "b", name: "B" },
      ];
      const result = serializeMultiItems(items);
      const parsed = JSON.parse(result);
      expect(parsed).toEqual([
        { e: 10, q: 1 },
        { e: 20, q: 3 },
      ]);
    });

    test("serializes empty array", () => {
      const result = serializeMultiItems([]);
      expect(result).toBe("[]");
    });

    test("omits unitPrice and slug from serialized output", () => {
      const items = [
        { eventId: 5, quantity: 1, unitPrice: 9999, slug: "secret-slug", name: "Secret Event" },
      ];
      const result = serializeMultiItems(items);
      expect(result).not.toContain("unitPrice");
      expect(result).not.toContain("slug");
      expect(result).not.toContain("9999");
      expect(result).not.toContain("secret-slug");
    });
  });

  describe("buildSingleIntentMetadata", () => {
    test("builds metadata with required fields", () => {
      const result = buildSingleIntentMetadata(42, {
        name: "Alice",
        email: "alice@example.com",
        quantity: 3,
      });
      expect(result).toEqual({
        event_id: "42",
        name: "Alice",
        email: "alice@example.com",
        quantity: "3",
      });
    });

    test("includes phone when provided", () => {
      const result = buildSingleIntentMetadata(1, {
        name: "Bob",
        email: "bob@example.com",
        phone: "+1234567890",
        quantity: 1,
      });
      expect(result.phone).toBe("+1234567890");
    });

    test("excludes phone when null", () => {
      const result = buildSingleIntentMetadata(1, {
        name: "Bob",
        email: "bob@example.com",
        phone: null,
        quantity: 1,
      });
      expect("phone" in result).toBe(false);
    });

    test("excludes phone when empty string", () => {
      const result = buildSingleIntentMetadata(1, {
        name: "Bob",
        email: "bob@example.com",
        phone: "",
        quantity: 1,
      });
      expect("phone" in result).toBe(false);
    });

    test("converts eventId and quantity to strings", () => {
      const result = buildSingleIntentMetadata(99, {
        name: "X",
        email: "x@x.com",
        quantity: 10,
      });
      expect(typeof result.event_id).toBe("string");
      expect(typeof result.quantity).toBe("string");
    });
  });

  describe("buildMultiIntentMetadata", () => {
    test("builds metadata with multi flag and serialized items", () => {
      const intent = {
        name: "Alice",
        email: "alice@example.com",
        phone: "",
        items: [
          { eventId: 1, quantity: 2, unitPrice: 1000, slug: "evt-1", name: "Evt 1" },
          { eventId: 2, quantity: 1, unitPrice: 500, slug: "evt-2", name: "Evt 2" },
        ],
      };
      const result = buildMultiIntentMetadata(intent);
      expect(result.multi).toBe("1");
      expect(result.name).toBe("Alice");
      expect(result.email).toBe("alice@example.com");
      const parsedItems = JSON.parse(result.items!);
      expect(parsedItems).toEqual([
        { e: 1, q: 2 },
        { e: 2, q: 1 },
      ]);
    });

    test("includes phone when provided", () => {
      const intent = {
        name: "Bob",
        email: "bob@example.com",
        phone: "+1234567890",
        items: [{ eventId: 1, quantity: 1, unitPrice: 100, slug: "e", name: "E" }],
      };
      const result = buildMultiIntentMetadata(intent);
      expect(result.phone).toBe("+1234567890");
    });

    test("excludes phone when empty string", () => {
      const intent = {
        name: "Bob",
        email: "bob@example.com",
        phone: "",
        items: [{ eventId: 1, quantity: 1, unitPrice: 100, slug: "e", name: "E" }],
      };
      const result = buildMultiIntentMetadata(intent);
      expect("phone" in result).toBe(false);
    });
  });

  describe("toCheckoutResult", () => {
    test("returns session result when both id and url provided", () => {
      const result = toCheckoutResult("sess_123", "https://pay.example.com", "Stripe");
      expect(result).toEqual({
        sessionId: "sess_123",
        checkoutUrl: "https://pay.example.com",
      });
    });

    test("returns null when sessionId is undefined", () => {
      const result = toCheckoutResult(undefined, "https://pay.example.com", "Stripe");
      expect(result).toBeNull();
    });

    test("returns null when url is undefined", () => {
      const result = toCheckoutResult("sess_123", undefined, "Stripe");
      expect(result).toBeNull();
    });

    test("returns null when url is null", () => {
      const result = toCheckoutResult("sess_123", null, "Stripe");
      expect(result).toBeNull();
    });

    test("returns null when both are undefined", () => {
      const result = toCheckoutResult(undefined, undefined, "Square");
      expect(result).toBeNull();
    });

    test("returns null when sessionId is empty string", () => {
      const result = toCheckoutResult("", "https://pay.example.com", "Stripe");
      expect(result).toBeNull();
    });

    test("returns null when url is empty string", () => {
      const result = toCheckoutResult("sess_123", "", "Payment");
      expect(result).toBeNull();
    });
  });

  describe("hasRequiredSessionMetadata", () => {
    test("returns true for valid single-event metadata", () => {
      const metadata = {
        name: "Alice",
        email: "alice@example.com",
        event_id: "42",
        quantity: "1",
      };
      expect(hasRequiredSessionMetadata(metadata)).toBe(true);
    });

    test("returns true for valid multi-event metadata", () => {
      const metadata = {
        name: "Alice",
        email: "alice@example.com",
        multi: "1",
        items: '[{"e":1,"q":2}]',
      };
      expect(hasRequiredSessionMetadata(metadata)).toBe(true);
    });

    test("returns false when metadata is null", () => {
      expect(hasRequiredSessionMetadata(null)).toBe(false);
    });

    test("returns false when metadata is undefined", () => {
      expect(hasRequiredSessionMetadata(undefined)).toBe(false);
    });

    test("returns false when name is missing", () => {
      const metadata = { email: "a@b.com", event_id: "1" };
      expect(hasRequiredSessionMetadata(metadata)).toBe(false);
    });

    test("returns false when email is missing", () => {
      const metadata = { name: "Alice", event_id: "1" };
      expect(hasRequiredSessionMetadata(metadata)).toBe(false);
    });

    test("returns false when neither event_id nor multi+items present", () => {
      const metadata = { name: "Alice", email: "a@b.com" };
      expect(hasRequiredSessionMetadata(metadata)).toBe(false);
    });

    test("returns false when multi is 1 but items is missing", () => {
      const metadata = { name: "Alice", email: "a@b.com", multi: "1" };
      expect(hasRequiredSessionMetadata(metadata)).toBe(false);
    });

    test("returns false when name is empty string", () => {
      const metadata = { name: "", email: "a@b.com", event_id: "1" };
      expect(hasRequiredSessionMetadata(metadata)).toBe(false);
    });

    test("returns false when email is empty string", () => {
      const metadata = { name: "Alice", email: "", event_id: "1" };
      expect(hasRequiredSessionMetadata(metadata)).toBe(false);
    });

    test("returns true when multi is 1 and items is a string", () => {
      const metadata = {
        name: "Alice",
        email: "a@b.com",
        multi: "1",
        items: "[]",
      };
      expect(hasRequiredSessionMetadata(metadata)).toBe(true);
    });

    test("returns false when multi is not 1", () => {
      const metadata = {
        name: "Alice",
        email: "a@b.com",
        multi: "0",
        items: "[]",
      };
      expect(hasRequiredSessionMetadata(metadata)).toBe(false);
    });
  });

  describe("extractSessionMetadata", () => {
    test("extracts all fields from single-event metadata", () => {
      const metadata = {
        event_id: "42",
        name: "Alice",
        email: "alice@example.com",
        phone: "+1234567890",
        quantity: "3",
      };
      const result = extractSessionMetadata(metadata);
      expect(result).toEqual({
        event_id: "42",
        name: "Alice",
        email: "alice@example.com",
        phone: "+1234567890",
        quantity: "3",
        multi: undefined,
        items: undefined,
      });
    });

    test("extracts all fields from multi-event metadata", () => {
      const metadata = {
        name: "Bob",
        email: "bob@example.com",
        multi: "1",
        items: '[{"e":1,"q":2}]',
      };
      const result = extractSessionMetadata(metadata);
      expect(result).toEqual({
        event_id: undefined,
        name: "Bob",
        email: "bob@example.com",
        phone: undefined,
        quantity: undefined,
        multi: "1",
        items: '[{"e":1,"q":2}]',
      });
    });

    test("sets optional fields to undefined when not present", () => {
      const metadata = {
        name: "Charlie",
        email: "charlie@example.com",
        event_id: "5",
      };
      const result = extractSessionMetadata(metadata);
      expect(result.phone).toBeUndefined();
      expect(result.quantity).toBeUndefined();
      expect(result.multi).toBeUndefined();
      expect(result.items).toBeUndefined();
    });

    test("preserves name and email as non-optional strings", () => {
      const metadata = {
        name: "Dana",
        email: "dana@example.com",
        event_id: "1",
      };
      const result = extractSessionMetadata(metadata);
      expect(result.name).toBe("Dana");
      expect(result.email).toBe("dana@example.com");
    });
  });
});
