import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  buildMetadata,
  extractSessionMetadata,
  hasRequiredSessionMetadata,
  singleListingAnswerIds,
  toBookingItems,
  toModifierRefs,
} from "#shared/payment-helpers.ts";
import type { CheckoutIntent, SessionMetadata } from "#shared/payments.ts";

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

    test("buildMetadata serializes allocations and round-trips them", () => {
      const allocations = [{ childId: 2, parentId: 1, qty: 1 }];
      const metadata = buildMetadata({
        allocations,
        date: null,
        email: "a@example.com",
        items: [{ e: 2, p: 1000, q: 1 }],
        name: "Alice",
      });
      expect(JSON.parse(metadata.allocations!)).toEqual(allocations);
      expect(
        JSON.parse(
          extractSessionMetadata(metadata as unknown as SessionMetadata)
            .allocations,
        ),
      ).toEqual(allocations);
    });

    test("buildMetadata carries the package id per signed line only", () => {
      // The package id rides each member line (`k:"p"`/`r:<id>`); there is no
      // order-level package key in the metadata at all.
      const metadata = buildMetadata({
        date: null,
        email: "a@example.com",
        items: [{ e: 2, k: "p", p: 1500, q: 1, r: 7 }],
        name: "Alice",
      });
      expect("package_group_id" in metadata).toBe(false);
      expect(JSON.parse(metadata.items!)).toEqual([
        { e: 2, k: "p", p: 1500, q: 1, r: 7 },
      ]);
    });
  });

  describe("metadata round-trip: build → validate → extract", () => {
    test("single-listing metadata survives full pipeline", () => {
      const metadata = buildMetadata({
        address: "123 Main St",
        balanceAttendeeId: 42,
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
      expect(extracted.balance_attendee_id).toBe("42");
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
        items: toBookingItems(intent),
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
        items: toBookingItems(intent),
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
        items: toBookingItems(intent),
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

    const checkoutIntent = (
      items: CheckoutIntent["items"],
      extra: Partial<CheckoutIntent> = {},
    ): CheckoutIntent => ({
      address: "",
      date: null,
      email: "e@e.com",
      items,
      name: "N",
      phone: "",
      special_instructions: "",
      ...extra,
    });

    test("toBookingItems produces compact items with total price", () => {
      const result = toBookingItems(
        checkoutIntent([
          { listingId: 10, name: "B", quantity: 3, slug: "b", unitPrice: 700 },
        ]),
      );
      expect(result).toEqual([{ e: 10, p: 2100, q: 3 }]);
    });

    test("toBookingItems handles empty array", () => {
      expect(toBookingItems(checkoutIntent([]))).toEqual([]);
    });

    test("toBookingItems tags a package member's line but not a folded child", () => {
      const result = toBookingItems(
        checkoutIntent(
          [
            {
              listingId: 5,
              name: "M",
              packageGroupId: 3,
              quantity: 2,
              slug: "m",
              unitPrice: 100,
            },
            {
              listingId: 9,
              name: "C",
              packageGroupId: 3,
              quantity: 2,
              slug: "c",
              unitPrice: 50,
            },
          ],
          { allocations: [{ childId: 9, parentId: 5, qty: 2 }] },
        ),
      );
      // The top-level member carries its package edge (k:"p", r=group id); the
      // folded child (in allocations) stays untagged.
      expect(result).toEqual([
        { e: 5, k: "p", p: 200, q: 2, r: 3 },
        { e: 9, p: 100, q: 2 },
      ]);
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
});
