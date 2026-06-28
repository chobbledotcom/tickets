import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  buildCatalog,
  buildCatalogEntry,
  type Catalog,
  isOriginAllowed,
  isVariablePrice,
  matchesHostPattern,
  resolveAllowOrigin,
  serializeCatalog,
} from "#shared/external-order.ts";
import { testListing } from "#test-utils/factories.ts";

describe("external-order", () => {
  describe("matchesHostPattern", () => {
    test("matches an exact hostname", () => {
      expect(matchesHostPattern("example.com", "example.com")).toBe(true);
    });

    test("rejects a different hostname", () => {
      expect(matchesHostPattern("evil.com", "example.com")).toBe(false);
    });

    test("wildcard matches a subdomain", () => {
      expect(matchesHostPattern("www.example.com", "*.example.com")).toBe(true);
    });

    test("wildcard does not match the bare apex", () => {
      expect(matchesHostPattern("example.com", "*.example.com")).toBe(false);
    });

    test("wildcard does not match a different domain", () => {
      expect(matchesHostPattern("www.evil.com", "*.example.com")).toBe(false);
    });
  });

  describe("isOriginAllowed", () => {
    test("empty allow-list permits any origin", () => {
      expect(isOriginAllowed("https://anywhere.test", [])).toBe(true);
    });

    test("empty allow-list permits a missing origin", () => {
      expect(isOriginAllowed(null, [])).toBe(true);
    });

    test("non-empty allow-list rejects a missing origin", () => {
      expect(isOriginAllowed(null, ["example.com"])).toBe(false);
    });

    test("allows a listed origin", () => {
      expect(isOriginAllowed("https://example.com", ["example.com"])).toBe(
        true,
      );
    });

    test("matches the origin's host case-insensitively", () => {
      expect(isOriginAllowed("https://EXAMPLE.com", ["example.com"])).toBe(
        true,
      );
    });

    test("rejects an unlisted origin", () => {
      expect(isOriginAllowed("https://evil.com", ["example.com"])).toBe(false);
    });

    test("rejects a malformed origin", () => {
      expect(isOriginAllowed("not a url", ["example.com"])).toBe(false);
    });

    test("ignores the origin port and path", () => {
      expect(isOriginAllowed("https://example.com:8443", ["example.com"])).toBe(
        true,
      );
    });
  });

  describe("resolveAllowOrigin", () => {
    test("empty allow-list returns wildcard", () => {
      expect(resolveAllowOrigin("https://x.test", [])).toBe("*");
    });

    test("allowed origin is echoed back", () => {
      expect(resolveAllowOrigin("https://example.com", ["example.com"])).toBe(
        "https://example.com",
      );
    });

    test("disallowed origin returns null", () => {
      expect(
        resolveAllowOrigin("https://evil.com", ["example.com"]),
      ).toBeNull();
    });

    test("missing origin with a non-empty list returns null", () => {
      expect(resolveAllowOrigin(null, ["example.com"])).toBeNull();
    });
  });

  describe("isVariablePrice", () => {
    test("standard fixed-price listing is not variable", () => {
      expect(
        isVariablePrice({
          can_pay_more: false,
          customisable_days: false,
          listing_type: "standard",
        }),
      ).toBe(false);
    });

    test("daily listing is variable (needs a date)", () => {
      expect(
        isVariablePrice({
          can_pay_more: false,
          customisable_days: false,
          listing_type: "daily",
        }),
      ).toBe(true);
    });

    test("customisable-days listing is variable", () => {
      expect(
        isVariablePrice({
          can_pay_more: false,
          customisable_days: true,
          listing_type: "standard",
        }),
      ).toBe(true);
    });

    test("pay-what-you-want listing is variable", () => {
      expect(
        isVariablePrice({
          can_pay_more: true,
          customisable_days: false,
          listing_type: "standard",
        }),
      ).toBe(true);
    });
  });

  describe("buildCatalogEntry", () => {
    test("active listing becomes a bookable entry with pricing", () => {
      const entry = buildCatalogEntry(
        testListing({
          id: 7,
          name: "Workshop",
          slug: "workshop",
          unit_price: 1500,
        }),
      );
      expect(entry).toEqual({
        bookable: true,
        id: 7,
        name: "Workshop",
        slug: "workshop",
        unitPrice: 1500,
        variablePrice: false,
      });
    });

    test("closed listing carries only slug + name", () => {
      const entry = buildCatalogEntry(
        testListing({ active: false, name: "Old Show", slug: "old-show" }),
      );
      expect(entry).toEqual({
        bookable: false,
        name: "Old Show",
        slug: "old-show",
      });
    });
  });

  describe("buildCatalog", () => {
    const base = {
      currency: "GBP",
      decimalPlaces: 2,
      generatedAt: "2026-06-28T20:00:00Z",
      origin: "https://tickets.test",
    };

    test("keys entries by slug and excludes hidden listings", () => {
      const catalog = buildCatalog({
        ...base,
        listings: [
          testListing({ id: 1, name: "Open", slug: "open" }),
          testListing({ hidden: true, id: 2, name: "Secret", slug: "secret" }),
          testListing({ active: false, id: 3, name: "Closed", slug: "closed" }),
        ],
      });
      expect(Object.keys(catalog.listings).sort()).toEqual(["closed", "open"]);
      expect(catalog.listings.open?.bookable).toBe(true);
      expect(catalog.listings.closed?.bookable).toBe(false);
      expect(catalog.origin).toBe("https://tickets.test");
      expect(catalog.currency).toBe("GBP");
      expect(catalog.decimalPlaces).toBe(2);
    });
  });

  describe("serializeCatalog", () => {
    const catalog: Catalog = {
      currency: "GBP",
      decimalPlaces: 2,
      generatedAt: "2026-06-28T20:00:00Z",
      listings: {},
      origin: "https://tickets.test",
    };

    test("produces a CATALOG const assignment", () => {
      expect(serializeCatalog(catalog)).toMatch(/^const CATALOG = \{/);
    });

    test("escapes < so it cannot form a closing script tag", () => {
      const withScript: Catalog = {
        ...catalog,
        listings: {
          x: {
            bookable: true,
            id: 1,
            name: "</script><img src=x>",
            slug: "x",
            unitPrice: 0,
            variablePrice: false,
          },
        },
      };
      const out = serializeCatalog(withScript);
      expect(out).not.toContain("</script>");
      expect(out).toContain("\\u003c");
    });

    test("round-trips to the original object", () => {
      const out = serializeCatalog(catalog);
      const json = out.slice("const CATALOG = ".length, -1);
      expect(JSON.parse(json)).toEqual(catalog);
    });
  });
});
