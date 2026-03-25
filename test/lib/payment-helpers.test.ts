import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ErrorCode } from "#lib/logger.ts";
import {
  buildCartMetadata,
  buildSingleIntentMetadata,
  createWithClient,
  errorMessage,
  extractSessionMetadata,
  hasRequiredSessionMetadata,
  PaymentUserError,
  safeAsync,
  serializeBookingItems,
  toCheckoutResult,
} from "#lib/payment-helpers.ts";
import { isPaymentStatus, type SessionMetadata } from "#lib/payments.ts";

describe("payment-helpers", () => {
  describe("metadata round-trip: build → validate → extract", () => {
    test("single-event metadata survives full pipeline", () => {
      const metadata = buildSingleIntentMetadata(42, {
        name: "Alice",
        email: "alice@example.com",
        phone: "+1234567890",
        address: "123 Main St",
        special_instructions: "No nuts",
        quantity: 3,
        date: "2026-02-10",
        answerIds: [10, 20],
      });

      expect(hasRequiredSessionMetadata(metadata)).toBe(true);

      const extracted = extractSessionMetadata(
        metadata as unknown as SessionMetadata,
      );
      expect(extracted.name).toBe("Alice");
      expect(extracted.email).toBe("alice@example.com");
      expect(extracted.phone).toBe("+1234567890");
      expect(extracted.address).toBe("123 Main St");
      expect(extracted.special_instructions).toBe("No nuts");
      expect(extracted.event_id).toBe("42");
      expect(extracted.quantity).toBe("3");
      expect(extracted.date).toBe("2026-02-10");
      expect(JSON.parse(extracted.answer_ids)).toEqual({ "42": [10, 20] });
    });

    test("cart metadata survives full pipeline", () => {
      const metadata = buildCartMetadata({
        name: "Bob",
        email: "bob@example.com",
        phone: "+9876543210",
        address: "",
        special_instructions: "",
        items: [
          {
            eventId: 1,
            quantity: 2,
            unitPrice: 1000,
            slug: "evt-1",
            name: "E1",
          },
          {
            eventId: 2,
            quantity: 1,
            unitPrice: 500,
            slug: "evt-2",
            name: "E2",
          },
        ],
        eventAnswerIds: { "1": [10], "2": [20, 21] },
      });

      expect(hasRequiredSessionMetadata(metadata)).toBe(true);

      const extracted = extractSessionMetadata(
        metadata as unknown as SessionMetadata,
      );
      expect(extracted.multi).toBe("1");
      expect(extracted.name).toBe("Bob");
      expect(extracted.phone).toBe("+9876543210");
      expect(extracted.address).toBe("");
      expect(JSON.parse(extracted.items)).toEqual([
        { e: 1, q: 2, p: 2000 },
        { e: 2, q: 1, p: 500 },
      ]);
      expect(JSON.parse(extracted.answer_ids)).toEqual({
        "1": [10],
        "2": [20, 21],
      });
    });

    test("extractSessionMetadata preserves present fields and defaults absent ones", () => {
      const withFields = extractSessionMetadata({
        event_id: "42",
        name: "Alice",
        email: "alice@example.com",
        phone: "+1234567890",
        quantity: "3",
      } as SessionMetadata);
      expect(withFields.email).toBe("alice@example.com");
      expect(withFields.phone).toBe("+1234567890");
      expect(withFields.address).toBe("");

      const minimal = extractSessionMetadata({
        name: "Eve",
      } as SessionMetadata);
      expect(minimal.email).toBe("");
      expect(minimal.phone).toBe("");
      expect(minimal._origin).toBe("");
      expect(minimal.event_id).toBe("");
    });

    test("optional fields omitted during build normalize to empty on extract", () => {
      const metadata = buildSingleIntentMetadata(1, {
        name: "Min",
        email: "min@example.com",
        address: "",
        special_instructions: "",
        quantity: 1,
      });

      const extracted = extractSessionMetadata(
        metadata as unknown as SessionMetadata,
      );
      expect(extracted.phone).toBe("");
      expect(extracted.address).toBe("");
      expect(extracted.special_instructions).toBe("");
      expect(extracted.date).toBe("");
      expect(extracted.answer_ids).toBe("");
    });

    test("cart with no phone, empty eventAnswerIds omits optional fields", () => {
      const metadata = buildCartMetadata({
        name: "Eve",
        email: "eve@example.com",
        phone: "",
        address: "",
        special_instructions: "",
        items: [
          { eventId: 5, quantity: 1, unitPrice: 100, slug: "e", name: "E" },
        ],
        eventAnswerIds: {},
      });

      expect("phone" in metadata).toBe(false);
      expect("answer_ids" in metadata).toBe(false);
    });

    test("single-event with date null omits date", () => {
      const metadata = buildSingleIntentMetadata(1, {
        name: "X",
        email: "x@x.com",
        address: "",
        special_instructions: "",
        quantity: 1,
        date: null,
      });
      expect("date" in metadata).toBe(false);
    });

    test("cart with date null omits date", () => {
      const metadata = buildCartMetadata({
        name: "X",
        email: "x@x.com",
        phone: "",
        address: "",
        special_instructions: "",
        date: null,
        items: [
          { eventId: 1, quantity: 1, unitPrice: 100, slug: "e", name: "E" },
        ],
      });
      expect("date" in metadata).toBe(false);
    });

    test("single-event with empty answerIds omits answer_ids", () => {
      const metadata = buildSingleIntentMetadata(1, {
        name: "X",
        email: "x@x.com",
        quantity: 1,
        answerIds: [],
      });
      expect("answer_ids" in metadata).toBe(false);
    });

    test("serializeBookingItems produces compact JSON with total price", () => {
      const items = [
        { eventId: 10, quantity: 3, unitPrice: 700, slug: "b", name: "B" },
      ];
      const result = serializeBookingItems(items);
      expect(JSON.parse(result)).toEqual([{ e: 10, q: 3, p: 2100 }]);
    });

    test("serializeBookingItems handles empty array", () => {
      expect(serializeBookingItems([])).toBe("[]");
    });
  });

  describe("hasRequiredSessionMetadata", () => {
    test("returns false for null/undefined", () => {
      expect(hasRequiredSessionMetadata(null)).toBe(false);
      expect(hasRequiredSessionMetadata(undefined)).toBe(false);
    });

    test("returns false when name is missing or empty", () => {
      expect(
        hasRequiredSessionMetadata({ email: "a@b.com", event_id: "1" }),
      ).toBe(false);
      expect(
        hasRequiredSessionMetadata({
          name: "",
          email: "a@b.com",
          event_id: "1",
        }),
      ).toBe(false);
    });

    test("returns false when neither event_id nor multi+items present", () => {
      expect(
        hasRequiredSessionMetadata({ name: "Alice", email: "a@b.com" }),
      ).toBe(false);
    });

    test("returns false when multi=1 but items missing", () => {
      expect(
        hasRequiredSessionMetadata({
          name: "Alice",
          email: "a@b.com",
          multi: "1",
        }),
      ).toBe(false);
    });

    test("returns false when multi is not '1'", () => {
      expect(
        hasRequiredSessionMetadata({
          name: "Alice",
          email: "a@b.com",
          multi: "0",
          items: "[]",
        }),
      ).toBe(false);
    });

    test("returns true for valid single-event (email optional)", () => {
      expect(hasRequiredSessionMetadata({ name: "Alice", event_id: "1" })).toBe(
        true,
      );
      expect(
        hasRequiredSessionMetadata({ name: "Alice", email: "", event_id: "1" }),
      ).toBe(true);
    });

    test("returns true for valid multi-event metadata", () => {
      expect(
        hasRequiredSessionMetadata({
          name: "Alice",
          email: "a@b.com",
          multi: "1",
          items: "[]",
        }),
      ).toBe(true);
    });
  });

  describe("isPaymentStatus", () => {
    test("accepts valid statuses", () => {
      expect(isPaymentStatus("paid")).toBe(true);
      expect(isPaymentStatus("unpaid")).toBe(true);
      expect(isPaymentStatus("no_payment_required")).toBe(true);
    });

    test("rejects invalid values", () => {
      expect(isPaymentStatus("completed")).toBe(false);
      expect(isPaymentStatus("")).toBe(false);
    });
  });

  describe("errorMessage", () => {
    test("extracts message from Error, returns fallback for non-Error", () => {
      expect(errorMessage(new Error("broke"))).toBe("broke");
      expect(errorMessage("string")).toBe("Unknown error");
      expect(errorMessage(null)).toBe("Unknown error");
    });
  });

  describe("safeAsync", () => {
    test("returns value on success, null on error", async () => {
      expect(
        await safeAsync(() => Promise.resolve(42), ErrorCode.PAYMENT_CHECKOUT),
      ).toBe(42);
      expect(
        await safeAsync(
          () => Promise.reject(new Error("boom")),
          ErrorCode.PAYMENT_CHECKOUT,
        ),
      ).toBeNull();
      expect(
        await safeAsync(
          () => Promise.reject("string error"),
          ErrorCode.PAYMENT_CHECKOUT,
        ),
      ).toBeNull();
    });

    test("re-throws PaymentUserError", async () => {
      await expect(
        safeAsync(
          () => Promise.reject(new PaymentUserError("Bad phone")),
          ErrorCode.PAYMENT_CHECKOUT,
        ),
      ).rejects.toThrow("Bad phone");
    });
  });

  describe("createWithClient", () => {
    test("returns null when client is null", async () => {
      const withClient = createWithClient(() => Promise.resolve(null));
      const result = await withClient(
        () => Promise.resolve("value"),
        ErrorCode.PAYMENT_CHECKOUT,
      );
      expect(result).toBeNull();
    });

    test("passes client to operation", async () => {
      const withClient = createWithClient(() =>
        Promise.resolve({ token: "abc" }),
      );
      expect(
        await withClient(
          (c) => Promise.resolve(`got-${c.token}`),
          ErrorCode.PAYMENT_CHECKOUT,
        ),
      ).toBe("got-abc");
    });

    test("returns null on operation error, re-throws PaymentUserError", async () => {
      const withClient = createWithClient(() =>
        Promise.resolve({ token: "abc" }),
      );
      expect(
        await withClient(
          () => Promise.reject(new Error("fail")),
          ErrorCode.PAYMENT_CHECKOUT,
        ),
      ).toBeNull();
      await expect(
        withClient(
          () => Promise.reject(new PaymentUserError("Phone invalid")),
          ErrorCode.PAYMENT_CHECKOUT,
        ),
      ).rejects.toThrow("Phone invalid");
    });
  });

  describe("serializeBookingItems", () => {
    test("serializes single item with total price to compact JSON", () => {
      const items = [
        { eventId: 1, quantity: 2, unitPrice: 1000, slug: "evt", name: "Evt" },
      ];
      const result = serializeBookingItems(items);
      expect(result).toBe(JSON.stringify([{ e: 1, q: 2, p: 2000 }]));
    });

    test("serializes multiple items preserving order", () => {
      const items = [
        { eventId: 10, quantity: 1, unitPrice: 500, slug: "a", name: "A" },
        { eventId: 20, quantity: 3, unitPrice: 700, slug: "b", name: "B" },
      ];
      const result = serializeBookingItems(items);
      const parsed = JSON.parse(result);
      expect(parsed).toEqual([
        { e: 10, q: 1, p: 500 },
        { e: 20, q: 3, p: 2100 },
      ]);
    });

    test("serializes empty array", () => {
      const result = serializeBookingItems([]);
      expect(result).toBe("[]");
    });

    test("omits slug from serialized output but includes total price", () => {
      const items = [
        {
          eventId: 5,
          quantity: 1,
          unitPrice: 9999,
          slug: "secret-slug",
          name: "Secret Event",
        },
      ];
      const result = serializeBookingItems(items);
      expect(result).not.toContain("unitPrice");
      expect(result).not.toContain("slug");
      expect(result).toContain("9999");
      expect(result).not.toContain("secret-slug");
    });
  });

  describe("buildSingleIntentMetadata", () => {
    test("builds metadata with required fields", () => {
      const result = buildSingleIntentMetadata(42, {
        name: "Alice",
        email: "alice@example.com",
        address: "",
        special_instructions: "",
        quantity: 3,
      });
      expect(result).toEqual({
        _origin: "localhost",
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
        address: "",
        special_instructions: "",
        quantity: 1,
      });
      expect(result.phone).toBe("+1234567890");
    });

    test("excludes phone when undefined", () => {
      const result = buildSingleIntentMetadata(1, {
        name: "Bob",
        email: "bob@example.com",
        phone: undefined,
        address: "",
        special_instructions: "",
        quantity: 1,
      });
      expect("phone" in result).toBe(false);
    });

    test("excludes phone when empty string", () => {
      const result = buildSingleIntentMetadata(1, {
        name: "Bob",
        email: "bob@example.com",
        phone: "",
        address: "",
        special_instructions: "",
        quantity: 1,
      });
      expect("phone" in result).toBe(false);
    });

    test("converts eventId and quantity to strings", () => {
      const result = buildSingleIntentMetadata(99, {
        name: "X",
        email: "x@x.com",
        address: "",
        special_instructions: "",
        quantity: 10,
      });
      expect(typeof result.event_id).toBe("string");
      expect(typeof result.quantity).toBe("string");
    });

    test("includes date when provided", () => {
      const result = buildSingleIntentMetadata(1, {
        name: "Alice",
        email: "alice@example.com",
        address: "",
        special_instructions: "",
        quantity: 1,
        date: "2026-02-10",
      });
      expect(result.date).toBe("2026-02-10");
    });

    test("excludes date when null", () => {
      const result = buildSingleIntentMetadata(1, {
        name: "Alice",
        email: "alice@example.com",
        address: "",
        special_instructions: "",
        quantity: 1,
        date: null,
      });
      expect("date" in result).toBe(false);
    });

    test("includes address when provided", () => {
      const result = buildSingleIntentMetadata(1, {
        name: "Bob",
        email: "bob@example.com",
        address: "123 Main St",
        quantity: 1,
      });
      expect(result.address).toBe("123 Main St");
    });

    test("excludes address when empty string", () => {
      const result = buildSingleIntentMetadata(1, {
        name: "Bob",
        email: "bob@example.com",
        address: "",
        special_instructions: "",
        quantity: 1,
      });
      expect("address" in result).toBe(false);
    });

    test("includes special_instructions when provided", () => {
      const result = buildSingleIntentMetadata(1, {
        name: "Bob",
        email: "bob@example.com",
        special_instructions: "No nuts please",
        quantity: 1,
      });
      expect(result.special_instructions).toBe("No nuts please");
    });

    test("excludes special_instructions when empty string", () => {
      const result = buildSingleIntentMetadata(1, {
        name: "Bob",
        email: "bob@example.com",
        special_instructions: "",
        quantity: 1,
      });
      expect("special_instructions" in result).toBe(false);
    });

    test("includes answer_ids in per-event format when provided", () => {
      const result = buildSingleIntentMetadata(1, {
        name: "Bob",
        email: "bob@example.com",
        quantity: 1,
        answerIds: [10, 20],
      });
      expect(JSON.parse(result.answer_ids)).toEqual({ "1": [10, 20] });
    });

    test("excludes answer_ids when empty array", () => {
      const result = buildSingleIntentMetadata(1, {
        name: "Bob",
        email: "bob@example.com",
        quantity: 1,
        answerIds: [],
      });
      expect("answer_ids" in result).toBe(false);
    });
  });

  describe("buildCartMetadata", () => {
    test("builds metadata with multi flag and serialized items", () => {
      const intent = {
        name: "Alice",
        email: "alice@example.com",
        phone: "",
        address: "",
        special_instructions: "",
        items: [
          {
            eventId: 1,
            quantity: 2,
            unitPrice: 1000,
            slug: "evt-1",
            name: "Evt 1",
          },
          {
            eventId: 2,
            quantity: 1,
            unitPrice: 500,
            slug: "evt-2",
            name: "Evt 2",
          },
        ],
      };
      const result = buildCartMetadata(intent);
      expect(result._origin).toBe("localhost");
      expect(result.multi).toBe("1");
      expect(result.name).toBe("Alice");
      expect(result.email).toBe("alice@example.com");
      const parsedItems = JSON.parse(result.items);
      expect(parsedItems).toEqual([
        { e: 1, q: 2, p: 2000 },
        { e: 2, q: 1, p: 500 },
      ]);
    });

    test("includes phone when provided", () => {
      const intent = {
        name: "Bob",
        email: "bob@example.com",
        phone: "+1234567890",
        address: "",
        special_instructions: "",
        items: [
          { eventId: 1, quantity: 1, unitPrice: 100, slug: "e", name: "E" },
        ],
      };
      const result = buildCartMetadata(intent);
      expect(result.phone).toBe("+1234567890");
    });

    test("excludes phone when empty string", () => {
      const intent = {
        name: "Bob",
        email: "bob@example.com",
        phone: "",
        address: "",
        special_instructions: "",
        items: [
          { eventId: 1, quantity: 1, unitPrice: 100, slug: "e", name: "E" },
        ],
      };
      const result = buildCartMetadata(intent);
      expect("phone" in result).toBe(false);
    });

    test("includes date when provided", () => {
      const intent = {
        name: "Alice",
        email: "alice@example.com",
        phone: "",
        address: "",
        special_instructions: "",
        date: "2026-02-10",
        items: [
          { eventId: 1, quantity: 1, unitPrice: 100, slug: "e", name: "E" },
        ],
      };
      const result = buildCartMetadata(intent);
      expect(result.date).toBe("2026-02-10");
    });

    test("excludes date when null", () => {
      const intent = {
        name: "Alice",
        email: "alice@example.com",
        phone: "",
        address: "",
        special_instructions: "",
        date: null,
        items: [
          { eventId: 1, quantity: 1, unitPrice: 100, slug: "e", name: "E" },
        ],
      };
      const result = buildCartMetadata(intent);
      expect("date" in result).toBe(false);
    });

    test("includes per-event answer IDs when provided", () => {
      const intent = {
        name: "Alice",
        email: "alice@example.com",
        phone: "",
        address: "",
        special_instructions: "",
        items: [
          { eventId: 1, quantity: 1, unitPrice: 100, slug: "e1", name: "E1" },
          { eventId: 2, quantity: 1, unitPrice: 200, slug: "e2", name: "E2" },
        ],
        eventAnswerIds: { "1": [10], "2": [20, 21] },
      };
      const result = buildCartMetadata(intent);
      expect(JSON.parse(result.answer_ids)).toEqual({
        "1": [10],
        "2": [20, 21],
      });
    });

    test("excludes answer_ids when eventAnswerIds is empty", () => {
      const intent = {
        name: "Alice",
        email: "alice@example.com",
        phone: "",
        address: "",
        special_instructions: "",
        items: [
          { eventId: 1, quantity: 1, unitPrice: 100, slug: "e", name: "E" },
        ],
        eventAnswerIds: {},
      };
      const result = buildCartMetadata(intent);
      expect("answer_ids" in result).toBe(false);
    });
  });

  describe("toCheckoutResult", () => {
    test("returns result when both id and url present", () => {
      expect(
        toCheckoutResult("sess_1", "https://pay.example.com", "Stripe"),
      ).toEqual({
        sessionId: "sess_1",
        checkoutUrl: "https://pay.example.com",
      });
    });

    test("returns null for missing or empty id/url", () => {
      expect(
        toCheckoutResult(undefined, "https://pay.example.com", "Stripe"),
      ).toBeNull();
      expect(toCheckoutResult("sess_1", undefined, "Stripe")).toBeNull();
      expect(toCheckoutResult("sess_1", null, "Stripe")).toBeNull();
      expect(
        toCheckoutResult("", "https://pay.example.com", "Stripe"),
      ).toBeNull();
      expect(toCheckoutResult("sess_1", "", "Payment")).toBeNull();
    });
  });
});
