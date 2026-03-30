import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ErrorCode } from "#lib/logger.ts";
import {
  buildMetadata,
  createWithClient,
  errorMessage,
  extractSessionMetadata,
  hasRequiredSessionMetadata,
  PaymentUserError,
  safeAsync,
  singleEventAnswerIds,
  toBookingItems,
  toCheckoutResult,
} from "#lib/payment-helpers.ts";
import { isPaymentStatus, type SessionMetadata } from "#lib/payments.ts";

describe("payment-helpers", () => {
  describe("metadata round-trip: build → validate → extract", () => {
    test("single-event metadata survives full pipeline", () => {
      const metadata = buildMetadata({
        name: "Alice",
        email: "alice@example.com",
        phone: "+1234567890",
        address: "123 Main St",
        special_instructions: "No nuts",
        date: "2026-02-10",
        items: [{ e: 42, q: 3, p: 0 }],
        eventAnswerIds: { "42": [10, 20] },
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
        name: "Bob",
        email: "bob@example.com",
        phone: "+9876543210",
        address: "",
        special_instructions: "",
        date: null,
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
        name: "Alice",
        email: "alice@example.com",
        phone: "+1234567890",
        items: "[]",
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
        name: "Min",
        email: "min@example.com",
        address: "",
        special_instructions: "",
        date: null,
        items: [{ e: 1, q: 1, p: 0 }],
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
        name: "Eve",
        email: "eve@example.com",
        phone: "",
        address: "",
        special_instructions: "",
        date: null,
        items: [
          { eventId: 5, quantity: 1, unitPrice: 100, slug: "e", name: "E" },
        ],
        eventAnswerIds: {},
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
        name: "X",
        email: "x@x.com",
        date: null,
        items: [{ e: 1, q: 1, p: 0 }],
      });
      expect("date" in metadata).toBe(false);
    });

    test("cart with date null omits date", () => {
      const intent = {
        name: "X",
        email: "x@x.com",
        phone: "",
        address: "",
        special_instructions: "",
        date: null,
        items: [
          { eventId: 1, quantity: 1, unitPrice: 100, slug: "e", name: "E" },
        ],
      };
      const metadata = buildMetadata({
        ...intent,
        items: toBookingItems(intent.items),
      });
      expect("date" in metadata).toBe(false);
    });

    test("single-event with empty answerIds omits answer_ids", () => {
      const metadata = buildMetadata({
        name: "X",
        email: "x@x.com",
        date: null,
        items: [{ e: 1, q: 1, p: 0 }],
        eventAnswerIds: {},
      });
      expect("answer_ids" in metadata).toBe(false);
    });

    test("toBookingItems produces compact items with total price", () => {
      const items = [
        { eventId: 10, quantity: 3, unitPrice: 700, slug: "b", name: "B" },
      ];
      const result = toBookingItems(items);
      expect(result).toEqual([{ e: 10, q: 3, p: 2100 }]);
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
          name: "",
          email: "a@b.com",
          items: "[]",
        }),
      ).toBe(false);
    });

    test("returns false when items missing", () => {
      expect(
        hasRequiredSessionMetadata({ name: "Alice", email: "a@b.com" }),
      ).toBe(false);
    });

    test("returns true for valid single-event (email optional)", () => {
      expect(hasRequiredSessionMetadata({ name: "Alice", items: "[]" })).toBe(
        true,
      );
      expect(
        hasRequiredSessionMetadata({ name: "Alice", email: "", items: "[]" }),
      ).toBe(true);
    });

    test("returns true for valid multi-event metadata", () => {
      expect(
        hasRequiredSessionMetadata({
          name: "Alice",
          email: "a@b.com",
          items: '[{"e":1,"q":2,"p":2000}]',
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
