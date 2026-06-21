import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { priceCheckout } from "#shared/checkout-pricing.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { ErrorCode } from "#shared/logger.ts";
import {
  buildItemsMetadata,
  buildMetadata,
  createWithClient,
  enforceMetadataLimits,
  errorMessage,
  extractSessionMetadata,
  hasRequiredSessionMetadata,
  PaymentUserError,
  packMetadata,
  safeAsync,
  singleListingAnswerIds,
  toBookingItems,
  toCheckoutResult,
  toModifierRefs,
} from "#shared/payment-helpers.ts";
import { verifyPrice } from "#shared/payment-signature.ts";
import {
  type CheckoutIntent,
  isPaymentStatus,
  type SessionMetadata,
} from "#shared/payments.ts";
import { describeWithEnv } from "#test-utils";

describe("payment-helpers", () => {
  describe("modifier metadata", () => {
    const spec = {
      id: 7,
      kind: "fixed" as const,
      listingIds: null,
      name: "Parking",
      quantity: 2,
      trigger: "automatic" as const,
      value: 500,
    };

    test("toModifierRefs compacts specs to id/quantity references", () => {
      expect(toModifierRefs([spec])).toEqual([{ i: 7, q: 2 }]);
    });

    test("toModifierRefs returns undefined for no modifiers", () => {
      expect(toModifierRefs(undefined)).toBeUndefined();
      expect(toModifierRefs([])).toBeUndefined();
    });

    test("buildMetadata serializes modifier references and round-trips them", () => {
      const metadata = buildMetadata({
        date: null,
        email: "a@example.com",
        items: [{ e: 1, p: 1000, q: 1 }],
        modifiers: [{ i: 7, q: 2 }],
        name: "Alice",
      });
      expect(JSON.parse(metadata.modifiers!)).toEqual([{ i: 7, q: 2 }]);
      const extracted = extractSessionMetadata(
        metadata as unknown as SessionMetadata,
      );
      expect(JSON.parse(extracted.modifiers)).toEqual([{ i: 7, q: 2 }]);
    });

    test("buildMetadata carries an explicit thank-you URL and round-trips it", () => {
      const metadata = buildMetadata({
        date: null,
        email: "a@example.com",
        items: [{ e: 1, p: 1000, q: 1 }],
        name: "Alice",
        thankYouUrl: "https://example.com/thanks-parent",
      });
      expect(metadata.thank_you_url).toBe("https://example.com/thanks-parent");
      expect(
        extractSessionMetadata(metadata as unknown as SessionMetadata)
          .thank_you_url,
      ).toBe("https://example.com/thanks-parent");
    });

    test("buildMetadata omits modifiers when none apply", () => {
      const metadata = buildMetadata({
        date: null,
        email: "a@example.com",
        items: [{ e: 1, p: 1000, q: 1 }],
        name: "Alice",
      });
      expect(metadata.modifiers).toBeUndefined();
      expect(
        extractSessionMetadata(metadata as unknown as SessionMetadata)
          .modifiers,
      ).toBe("");
    });
  });

  describe("metadata round-trip: build → validate → extract", () => {
    test("single-listing metadata survives full pipeline", () => {
      const metadata = buildMetadata({
        address: "123 Main St",
        date: "2026-02-10",
        email: "alice@example.com",
        items: [{ e: 42, p: 0, q: 3 }],
        listingAnswerIds: { "42": [10, 20] },
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
        items: [
          {
            listingId: 1,
            name: "E1",
            quantity: 2,
            slug: "evt-1",
            unitPrice: 1000,
          },
          {
            listingId: 2,
            name: "E2",
            quantity: 1,
            slug: "evt-2",
            unitPrice: 500,
          },
        ],
        listingAnswerIds: { "1": [10], "2": [20, 21] },
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

    test("serializes per-listing free-text answer references into metadata", () => {
      const metadata = buildMetadata({
        address: "",
        date: null,
        email: "free@example.com",
        items: [{ e: 7, p: 0, q: 1 }],
        listingTextAnswerIds: { "7": [{ q: 3, s: 99 }] },
        name: "Freya",
        special_instructions: "",
      });

      expect(JSON.parse(metadata.text_answer_ids!)).toEqual({
        "7": [{ q: 3, s: 99 }],
      });
    });

    test("omits text_answer_ids when the free-text map is empty", () => {
      const metadata = buildMetadata({
        address: "",
        date: null,
        email: "free@example.com",
        items: [{ e: 7, p: 0, q: 1 }],
        listingTextAnswerIds: {},
        name: "Freya",
        special_instructions: "",
      });

      expect("text_answer_ids" in metadata).toBe(false);
    });

    test("cart with no phone, empty listingAnswerIds omits optional fields", () => {
      const intent = {
        address: "",
        date: null,
        email: "eve@example.com",
        items: [
          { listingId: 5, name: "E", quantity: 1, slug: "e", unitPrice: 100 },
        ],
        listingAnswerIds: {},
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

    test("single-listing with date null omits date", () => {
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
          { listingId: 1, name: "E", quantity: 1, slug: "e", unitPrice: 100 },
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

    test("single-listing with empty answerIds omits answer_ids", () => {
      const metadata = buildMetadata({
        date: null,
        email: "x@x.com",
        items: [{ e: 1, p: 0, q: 1 }],
        listingAnswerIds: {},
        name: "X",
      });
      expect("answer_ids" in metadata).toBe(false);
    });

    test("buildMetadata includes site_token_index when present", () => {
      const metadata = buildMetadata({
        date: null,
        email: "renew@example.com",
        items: [{ e: 5, p: 1500, q: 3 }],
        name: "Renewer",
        siteTokenIndex: "hashed-index-value",
      });
      expect(metadata.site_token_index).toBe("hashed-index-value");
    });

    test("buildMetadata omits site_token_index when absent", () => {
      const metadata = buildMetadata({
        date: null,
        email: "x@x.com",
        items: [{ e: 1, p: 0, q: 1 }],
        name: "X",
      });
      expect("site_token_index" in metadata).toBe(false);
    });

    test("buildMetadata includes day_count when present", () => {
      const metadata = buildMetadata({
        date: "2026-07-01",
        dayCount: 3,
        email: "buyer@example.com",
        items: [{ e: 5, p: 2500, q: 1 }],
        name: "Buyer",
      });
      expect(metadata.day_count).toBe("3");
    });

    test("buildMetadata omits day_count when absent", () => {
      const metadata = buildMetadata({
        date: null,
        email: "x@x.com",
        items: [{ e: 1, p: 0, q: 1 }],
        name: "X",
      });
      expect("day_count" in metadata).toBe(false);
    });

    test("extractSessionMetadata round-trips day_count", () => {
      const extracted = extractSessionMetadata({
        day_count: "3",
        email: "x@x.com",
        items: "[]",
        name: "X",
      } as SessionMetadata);
      expect(extracted.day_count).toBe("3");
    });

    test("extractSessionMetadata surfaces site_token_index when present", () => {
      const extracted = extractSessionMetadata({
        email: "renew@example.com",
        items: "[]",
        name: "Renewer",
        site_token_index: "hashed-index-value",
      } as SessionMetadata);
      expect(extracted.site_token_index).toBe("hashed-index-value");
    });

    test("extractSessionMetadata defaults site_token_index to empty string", () => {
      const extracted = extractSessionMetadata({
        email: "x@x.com",
        items: "[]",
        name: "X",
      } as SessionMetadata);
      expect(extracted.site_token_index).toBe("");
    });

    test("toBookingItems produces compact items with total price", () => {
      const items = [
        { listingId: 10, name: "B", quantity: 3, slug: "b", unitPrice: 700 },
      ];
      const result = toBookingItems(items);
      expect(result).toEqual([{ e: 10, p: 2100, q: 3 }]);
    });

    test("toBookingItems handles empty array", () => {
      expect(toBookingItems([])).toEqual([]);
    });

    test("singleListingAnswerIds wraps answerIds for one listing", () => {
      expect(singleListingAnswerIds(42, [10, 20])).toEqual({ "42": [10, 20] });
    });

    test("singleListingAnswerIds returns undefined for empty or missing", () => {
      expect(singleListingAnswerIds(1, [])).toBeUndefined();
      expect(singleListingAnswerIds(1, undefined)).toBeUndefined();
      expect(singleListingAnswerIds(1)).toBeUndefined();
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

    test("returns true for valid single-listing (email optional)", () => {
      expect(hasRequiredSessionMetadata({ items: "[]", name: "Alice" })).toBe(
        true,
      );
      expect(
        hasRequiredSessionMetadata({ email: "", items: "[]", name: "Alice" }),
      ).toBe(true);
    });

    test("returns true for valid multi-listing metadata", () => {
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
        /too many listings/i,
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

    test("throws PaymentUserError when text_answer_ids exceeds limit", () => {
      const longTextAnswerIds = JSON.stringify(
        Object.fromEntries(
          Array.from({ length: 20 }, (_, i) => [
            String(i),
            Array.from({ length: 10 }, (_, j) => ({ q: j, s: j })),
          ]),
        ),
      );
      const metadata = {
        email: "john@example.com",
        items: '[{"e":1,"q":1,"p":0}]',
        name: "John",
        text_answer_ids: longTextAnswerIds,
      };
      expect(() => enforceMetadataLimits(metadata, 255)).toThrow(
        PaymentUserError,
      );
      expect(() => enforceMetadataLimits(metadata, 255)).toThrow(
        /too many options/i,
      );
    });

    test("throws PaymentUserError when modifiers exceeds limit", () => {
      const longModifiers = JSON.stringify(
        Array.from({ length: 40 }, (_, i) => ({ i, q: 1 })),
      );
      const metadata = {
        email: "john@example.com",
        items: '[{"e":1,"q":1,"p":0}]',
        modifiers: longModifiers,
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

    test("throws PaymentUserError when the packed `b` exceeds the limit", () => {
      const metadata = {
        b: "X".repeat(256),
        email: "j@x.com",
        items: '[{"e":1,"q":1,"p":0}]',
        name: "John",
      };
      expect(() => enforceMetadataLimits(metadata, 255)).toThrow(
        PaymentUserError,
      );
      expect(() => enforceMetadataLimits(metadata, 255)).toThrow(
        /too much booking detail/i,
      );
    });

    test("passes through a packed `b` within the limit", () => {
      const metadata = {
        b: JSON.stringify({ phone: "555" }),
        email: "j@x.com",
        items: '[{"e":1,"q":1,"p":0}]',
        name: "John",
      };
      expect(enforceMetadataLimits(metadata, 255)).toEqual(metadata);
    });

    test("throws when the entry count exceeds the cap (Square's 10-key limit)", () => {
      // 11 short values — only the key count is over the cap, not any length.
      const metadata = Object.fromEntries(
        Array.from({ length: 11 }, (_, i) => [`k${i}`, "x"]),
      );
      expect(() => enforceMetadataLimits(metadata, 255, 10)).toThrow(
        PaymentUserError,
      );
      expect(() => enforceMetadataLimits(metadata, 255, 10)).toThrow(
        /too many options/i,
      );
    });

    test("allows the entry count at the cap, and ignores it when unset (Stripe)", () => {
      const tenKeys = Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [`k${i}`, "x"]),
      );
      expect(enforceMetadataLimits(tenKeys, 255, 10)).toEqual(tenKeys);
      // Stripe supplies no entry cap, so a high key count passes through.
      const manyKeys = Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [`k${i}`, "x"]),
      );
      expect(enforceMetadataLimits(manyKeys, 500)).toEqual(manyKeys);
    });
  });

  describe("metadata packing codec", () => {
    test("packs the small fields into one `b` entry and drops them", () => {
      const packed = packMetadata({
        _origin: "x",
        date: "2026-07-01",
        email: "a@b.com",
        items: "[]",
        name: "Al",
        phone: "555",
        site_token_index: "hash",
      });
      // Small fields move into `b`; large/identity fields stay top-level.
      expect("phone" in packed).toBe(false);
      expect("date" in packed).toBe(false);
      expect("site_token_index" in packed).toBe(false);
      expect(packed.email).toBe("a@b.com");
      expect(packed.items).toBe("[]");
      expect(packed.name).toBe("Al");
      expect(packed._origin).toBe("x");
      expect(JSON.parse(packed.b!)).toEqual({
        date: "2026-07-01",
        phone: "555",
        site_token_index: "hash",
      });
    });

    test("omits `b` when no small field is present (falsy ones don't pack)", () => {
      const packed = packMetadata({
        email: "a@b.com",
        items: "[]",
        name: "Al",
        phone: "",
      });
      expect("b" in packed).toBe(false);
      expect("phone" in packed).toBe(false);
      expect(packed).toEqual({ email: "a@b.com", items: "[]", name: "Al" });
    });

    test("round-trips packed fields back through extractSessionMetadata", () => {
      const wire = packMetadata({
        _origin: "x",
        date: "2026-07-01",
        email: "a@b.com",
        items: "[]",
        modifiers: '[{"i":1,"q":1}]',
        name: "Al",
        phone: "555",
      });
      const extracted = extractSessionMetadata(
        wire as unknown as SessionMetadata,
      );
      expect(extracted.phone).toBe("555");
      expect(extracted.date).toBe("2026-07-01");
      expect(extracted.modifiers).toBe('[{"i":1,"q":1}]');
      expect(extracted.email).toBe("a@b.com");
    });

    test("a malformed `b` blob degrades packed fields to empty, never throws", () => {
      const extracted = extractSessionMetadata({
        b: "not json{",
        email: "a@b.com",
        items: "[]",
        name: "Al",
      } as unknown as SessionMetadata);
      expect(extracted.phone).toBe("");
      expect(extracted.date).toBe("");
      expect(extracted.email).toBe("a@b.com");
    });

    test("a non-object or null `b` is ignored", () => {
      for (const b of ["123", "null", '"a string"']) {
        const extracted = extractSessionMetadata({
          b,
          items: "[]",
          name: "Al",
        } as unknown as SessionMetadata);
        expect(extracted.phone).toBe("");
      }
    });

    test("a non-string packed field is dropped, string siblings kept", () => {
      const extracted = extractSessionMetadata({
        b: '{"phone":123,"date":"2026-07-01"}',
        items: "[]",
        name: "Al",
      } as unknown as SessionMetadata);
      expect(extracted.phone).toBe("");
      expect(extracted.date).toBe("2026-07-01");
    });
  });
});

// hmacHash needs the encryption key configured, which describeWithEnv handles.
describeWithEnv(
  "buildItemsMetadata site-token hashing",
  { encryptionKey: true },
  () => {
    const baseIntent = (siteToken?: string): CheckoutIntent => ({
      address: "",
      date: null,
      email: "renew@example.com",
      items: [
        {
          listingId: 1,
          name: "Tier",
          quantity: 1,
          slug: "t",
          unitPrice: 0,
        },
      ],
      name: "Renewer",
      phone: "",
      special_instructions: "",
      ...(siteToken ? { siteToken } : {}),
    });

    test("emits site_token_index as the HMAC of the plain token", async () => {
      const metadata = await buildItemsMetadata(
        baseIntent("plain-token-xyz"),
        0,
      );
      const expected = await hmacHash("plain-token-xyz");
      // site_token_index is packed into `b` on the wire; the webhook recovers it
      // via extractSessionMetadata, so assert on that recovered value.
      expect(
        extractSessionMetadata(metadata as unknown as SessionMetadata)
          .site_token_index,
      ).toBe(expected);
    });

    test("plain token never appears in metadata", async () => {
      const metadata = await buildItemsMetadata(
        baseIntent("plain-token-xyz"),
        0,
      );
      for (const value of Object.values(metadata)) {
        expect(value.includes("plain-token-xyz")).toBe(false);
      }
    });

    test("omits site_token_index when siteToken is absent", async () => {
      const metadata = await buildItemsMetadata(baseIntent(), 0);
      expect("site_token_index" in metadata).toBe(false);
    });
  },
);

// The proof is signed over the logical metadata; Square then packs the small
// fields. This proves the webhook's unpack-then-verify reproduces the proof, and
// that tampering a packed field is still caught after the round-trip.
describeWithEnv(
  "buildItemsMetadata price proof survives packing",
  { encryptionKey: true },
  () => {
    const intent: CheckoutIntent = {
      address: "",
      date: "2026-07-01",
      email: "buyer@example.com",
      items: [
        { listingId: 1, name: "Tier", quantity: 2, slug: "t", unitPrice: 1000 },
      ],
      name: "Buyer",
      phone: "07700900000",
      special_instructions: "",
    };

    test("the signed proof verifies against the unpacked metadata", async () => {
      const total = priceCheckout(intent).total;
      // Apply the Square packing step over the signed metadata.
      const wire = packMetadata(await buildItemsMetadata(intent, total));
      // Small fields (phone, date, …) are packed on the wire.
      expect("phone" in wire).toBe(false);
      expect(typeof wire.b).toBe("string");

      const extracted = extractSessionMetadata(
        wire as unknown as SessionMetadata,
      );
      const dot = extracted.price_proof.indexOf(".");
      const signedTotal = Number(extracted.price_proof.slice(0, dot));
      const sig = extracted.price_proof.slice(dot + 1);
      expect(signedTotal).toBe(total);
      expect(await verifyPrice(extracted, signedTotal, sig)).toBe(true);

      // Tampering a field that was packed-then-unpacked is still detected.
      expect(
        await verifyPrice(
          { ...extracted, phone: "07000000000" },
          signedTotal,
          sig,
        ),
      ).toBe(false);
    });
  },
);
