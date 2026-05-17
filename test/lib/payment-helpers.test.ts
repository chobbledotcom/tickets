import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ErrorCode } from "#shared/logger.ts";
import {
  buildMetadata,
  createWithClient,
  enforceMetadataLimits,
  errorMessage,
  extractSessionMetadata,
  hasRequiredSessionMetadata,
  PaymentUserError,
  safeAsync,
  singleEventAnswerIds,
  toBookingItems,
  toCheckoutResult,
} from "#shared/payment-helpers.ts";
import { isPaymentStatus, type SessionMetadata } from "#shared/payments.ts";

describe("payment-helpers", () => {
  describe("metadata round-trip: build → validate → extract", () => {
    test("single-event metadata survives full pipeline", () => {
      const metadata = buildMetadata({
        address: "123 Main St",
        date: "2026-02-10",
        email: "alice@example.com",
        eventAnswerIds: { "42": [10, 20] },
        items: [{ e: 42, p: 0, q: 3 }],
        name: "Alice",
        phone: "+1234567890",
        special_instructions: "No nuts",
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
      expect(extracted.date).toBe("2026-02-10");
      expect(JSON.parse(extracted.answer_ids)).toEqual({ "42": [10, 20] });
    });

    test("cart metadata survives full pipeline", () => {
      const intent = {
        address: "",
        date: null,
        email: "bob@example.com",
        eventAnswerIds: { "1": [10], "2": [20, 21] },
        items: [
          {
            eventId: 1,
            name: "E1",
            quantity: 2,
            slug: "evt-1",
            unitPrice: 1000,
          },
          {
            eventId: 2,
            name: "E2",
            quantity: 1,
            slug: "evt-2",
            unitPrice: 500,
          },
        ],
        name: "Bob",
        phone: "+9876543210",
        special_instructions: "",
      };
      const metadata = buildMetadata({
        ...intent,
        items: toBookingItems(intent.items),
      });

      expect(hasRequiredSessionMetadata(metadata)).toBe(true);

      const extracted = extractSessionMetadata(
        metadata as unknown as SessionMetadata,
      );
      expect(extracted.name).toBe("Bob");
      expect(extracted.phone).toBe("+9876543210");
      expect(extracted.address).toBe("");
      expect(JSON.parse(extracted.items)).toEqual([
        { e: 1, p: 2000, q: 2 },
        { e: 2, p: 500, q: 1 },
      ]);
      expect(JSON.parse(extracted.answer_ids)).toEqual({
        "1": [10],
        "2": [20, 21],
      });
    });

    test("extractSessionMetadata preserves present fields and defaults absent ones", () => {
      const withFields = extractSessionMetadata({
        email: "alice@example.com",
        items: "[]",
        name: "Alice",
        phone: "+1234567890",
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
    });

    test("optional fields omitted during build normalize to empty on extract", () => {
      const metadata = buildMetadata({
        address: "",
        date: null,
        email: "min@example.com",
        items: [{ e: 1, p: 0, q: 1 }],
        name: "Min",
        special_instructions: "",
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
      const intent = {
        address: "",
        date: null,
        email: "eve@example.com",
        eventAnswerIds: {},
        items: [
          { eventId: 5, name: "E", quantity: 1, slug: "e", unitPrice: 100 },
        ],
        name: "Eve",
        phone: "",
        special_instructions: "",
      };
      const metadata = buildMetadata({
        ...intent,
        items: toBookingItems(intent.items),
      });

      expect("phone" in metadata).toBe(false);
      expect("answer_ids" in metadata).toBe(false);
    });

    test("single-event with date null omits date", () => {
      const metadata = buildMetadata({
        date: null,
        email: "x@x.com",
        items: [{ e: 1, p: 0, q: 1 }],
        name: "X",
      });
      expect("date" in metadata).toBe(false);
    });

    test("cart with date null omits date", () => {
      const intent = {
        address: "",
        date: null,
        email: "x@x.com",
        items: [
          { eventId: 1, name: "E", quantity: 1, slug: "e", unitPrice: 100 },
        ],
        name: "X",
        phone: "",
        special_instructions: "",
      };
      const metadata = buildMetadata({
        ...intent,
        items: toBookingItems(intent.items),
      });
      expect("date" in metadata).toBe(false);
    });

    test("single-event with empty answerIds omits answer_ids", () => {
      const metadata = buildMetadata({
        date: null,
        email: "x@x.com",
        eventAnswerIds: {},
        items: [{ e: 1, p: 0, q: 1 }],
        name: "X",
      });
      expect("answer_ids" in metadata).toBe(false);
    });

    test("buildMetadata includes site_token when present", () => {
      const metadata = buildMetadata({
        date: null,
        email: "renew@example.com",
        items: [{ e: 5, p: 1500, q: 3 }],
        name: "Renewer",
        siteToken: "abc123token",
      });
      expect(metadata.site_token).toBe("abc123token");
    });

    test("buildMetadata omits site_token when absent", () => {
      const metadata = buildMetadata({
        date: null,
        email: "x@x.com",
        items: [{ e: 1, p: 0, q: 1 }],
        name: "X",
      });
      expect("site_token" in metadata).toBe(false);
    });

    test("extractSessionMetadata surfaces site_token when present", () => {
      const extracted = extractSessionMetadata({
        email: "renew@example.com",
        items: "[]",
        name: "Renewer",
        site_token: "abc123token",
      } as SessionMetadata);
      expect(extracted.site_token).toBe("abc123token");
    });

    test("extractSessionMetadata defaults site_token to empty string", () => {
      const extracted = extractSessionMetadata({
        email: "x@x.com",
        items: "[]",
        name: "X",
      } as SessionMetadata);
      expect(extracted.site_token).toBe("");
    });

    test("toBookingItems produces compact items with total price", () => {
      const items = [
        { eventId: 10, name: "B", quantity: 3, slug: "b", unitPrice: 700 },
      ];
      const result = toBookingItems(items);
      expect(result).toEqual([{ e: 10, p: 2100, q: 3 }]);
    });

    test("toBookingItems handles empty array", () => {
      expect(toBookingItems([])).toEqual([]);
    });

    test("singleEventAnswerIds wraps answerIds for one event", () => {
      expect(singleEventAnswerIds(42, [10, 20])).toEqual({ "42": [10, 20] });
    });

    test("singleEventAnswerIds returns undefined for empty or missing", () => {
      expect(singleEventAnswerIds(1, [])).toBeUndefined();
      expect(singleEventAnswerIds(1, undefined)).toBeUndefined();
      expect(singleEventAnswerIds(1)).toBeUndefined();
    });
  });

  describe("hasRequiredSessionMetadata", () => {
    test("returns false for null/undefined", () => {
      expect(hasRequiredSessionMetadata(null)).toBe(false);
      expect(hasRequiredSessionMetadata(undefined)).toBe(false);
    });

    test("returns false when name is missing or empty", () => {
      expect(
        hasRequiredSessionMetadata({ email: "a@b.com", items: "[]" }),
      ).toBe(false);
      expect(
        hasRequiredSessionMetadata({
          email: "a@b.com",
          items: "[]",
          name: "",
        }),
      ).toBe(false);
    });

    test("returns false when items missing", () => {
      expect(
        hasRequiredSessionMetadata({ email: "a@b.com", name: "Alice" }),
      ).toBe(false);
    });

    test("returns true for valid single-event (email optional)", () => {
      expect(hasRequiredSessionMetadata({ items: "[]", name: "Alice" })).toBe(
        true,
      );
      expect(
        hasRequiredSessionMetadata({ email: "", items: "[]", name: "Alice" }),
      ).toBe(true);
    });

    test("returns true for valid multi-event metadata", () => {
      expect(
        hasRequiredSessionMetadata({
          email: "a@b.com",
          items: '[{"e":1,"q":2,"p":2000}]',
          name: "Alice",
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

  describe("toCheckoutResult", () => {
    test("returns result when both id and url present", () => {
      expect(
        toCheckoutResult("sess_1", "https://pay.example.com", "Stripe"),
      ).toEqual({
        checkoutUrl: "https://pay.example.com",
        sessionId: "sess_1",
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

  describe("enforceMetadataLimits", () => {
    test("returns metadata unchanged when all values within limit", () => {
      const metadata = {
        email: "john@example.com",
        items: '[{"e":1,"q":2,"p":0}]',
        name: "John",
      };
      expect(enforceMetadataLimits(metadata, 255)).toEqual(metadata);
    });

    test("returns metadata unchanged when items exactly at limit", () => {
      const items = "X".repeat(255);
      const metadata = { email: "j@x.com", items, name: "John" };
      expect(enforceMetadataLimits(metadata, 255)).toEqual(metadata);
    });

    test("throws PaymentUserError when items JSON exceeds limit", () => {
      const longItems = JSON.stringify(
        Array.from({ length: 30 }, (_, i) => ({ e: i, p: 100, q: 1 })),
      );
      const metadata = {
        email: "john@example.com",
        items: longItems,
        name: "John",
      };
      expect(() => enforceMetadataLimits(metadata, 255)).toThrow(
        PaymentUserError,
      );
      expect(() => enforceMetadataLimits(metadata, 255)).toThrow(
        /too many events/i,
      );
    });

    test("throws PaymentUserError when answer_ids exceeds limit", () => {
      const longAnswerIds = JSON.stringify(
        Object.fromEntries(
          Array.from({ length: 20 }, (_, i) => [
            String(i),
            Array.from({ length: 10 }, (_, j) => j),
          ]),
        ),
      );
      const metadata = {
        answer_ids: longAnswerIds,
        email: "john@example.com",
        items: '[{"e":1,"q":1,"p":0}]',
        name: "John",
      };
      expect(() => enforceMetadataLimits(metadata, 255)).toThrow(
        PaymentUserError,
      );
      expect(() => enforceMetadataLimits(metadata, 255)).toThrow(
        /too many options/i,
      );
    });

    test("items within Stripe limit (500) but over Square limit (255)", () => {
      const items = JSON.stringify(
        Array.from({ length: 15 }, (_, i) => ({ e: i, p: 100, q: 1 })),
      );
      const metadata = { email: "j@x.com", items, name: "John" };
      expect(enforceMetadataLimits(metadata, 500).items).toBe(items);
      expect(() => enforceMetadataLimits(metadata, 255)).toThrow(
        PaymentUserError,
      );
    });

    test("passes through when answer_ids is absent", () => {
      const metadata = {
        email: "j@x.com",
        items: '[{"e":1,"q":1,"p":0}]',
        name: "John",
      };
      expect(enforceMetadataLimits(metadata, 255)).toEqual(metadata);
    });
  });
});
