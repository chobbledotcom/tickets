import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  enforceMetadataLimits,
  extractSessionMetadata,
  PaymentUserError,
  packMetadata,
} from "#shared/payment-helpers.ts";
import type { SessionMetadata } from "#shared/payments.ts";
import { expectThrows } from "#test-utils/assertions.ts";

describe("payment-helpers", () => {
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
      expectThrows(
        () => enforceMetadataLimits(metadata, 255),
        PaymentUserError,
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
      expectThrows(
        () => enforceMetadataLimits(metadata, 255),
        PaymentUserError,
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
      expectThrows(
        () => enforceMetadataLimits(metadata, 255),
        PaymentUserError,
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
      expectThrows(
        () => enforceMetadataLimits(metadata, 255),
        PaymentUserError,
        /too many options/i,
      );
    });

    test("throws PaymentUserError when allocations exceeds limit", () => {
      // Every package pick adds an allocation, so this field grows fastest; a
      // large multi-slot checkout must surface the app's batching message, not a
      // raw provider rejection.
      const longAllocations = JSON.stringify(
        Array.from({ length: 40 }, (_, i) => ({ childId: i, parentId: 1 })),
      );
      const metadata = {
        allocations: longAllocations,
        email: "john@example.com",
        items: '[{"e":1,"q":1,"p":0}]',
        name: "John",
      };
      expectThrows(
        () => enforceMetadataLimits(metadata, 255),
        PaymentUserError,
        /too many options/i,
      );
    });

    test("passes through allocations within the limit", () => {
      const metadata = {
        allocations: JSON.stringify([{ childId: 2, parentId: 1 }]),
        email: "j@x.com",
        items: '[{"e":1,"q":1,"p":0}]',
        name: "John",
      };
      expect(enforceMetadataLimits(metadata, 255)).toEqual(metadata);
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
      expectThrows(
        () => enforceMetadataLimits(metadata, 255),
        PaymentUserError,
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

    test("leaves a too-long thank_you_url untouched (capping moved pre-sign)", () => {
      // enforceMetadataLimits no longer strips thank_you_url: that is done in
      // buildItemsMetadata before signing so the proof and metadata stay
      // consistent. An over-cap URL passing through here is
      // unchanged (it never reaches here over-cap in production).
      const metadata = {
        email: "j@x.com",
        items: '[{"e":1,"q":1,"p":0}]',
        name: "John",
        thank_you_url: `https://example.com/${"x".repeat(255)}`,
      };
      expect(enforceMetadataLimits(metadata, 255)).toEqual(metadata);
    });
  });

  describe("metadata packing codec", () => {
    test("packs the small fields into one `b` entry and drops them", () => {
      const packed = packMetadata({
        _origin: "x",
        balance_attendee_id: "42",
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
      expect("balance_attendee_id" in packed).toBe(false);
      expect(packed.email).toBe("a@b.com");
      expect(packed.items).toBe("[]");
      expect(packed.name).toBe("Al");
      expect(packed._origin).toBe("x");
      expect(JSON.parse(packed.b!)).toEqual({
        balance_attendee_id: "42",
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

    test("packs exactly one small field", () => {
      expect(packMetadata({ phone: "555" })).toEqual({
        b: '{"phone":"555"}',
      });
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
