import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  buildCatalog,
  resolveAllowOrigin,
  serializeCatalog,
} from "#shared/external-order.ts";
import { testListing } from "#test-utils/factories.ts";

const base = {
  currency: "GBP",
  decimalPlaces: 2,
  generatedAt: "2026-06-28T20:00:00Z",
  origin: "https://tickets.test",
};

describe("external-order", () => {
  describe("resolveAllowOrigin", () => {
    test("empty allow-list returns wildcard for any origin", () => {
      expect(resolveAllowOrigin("https://anywhere.test", [])).toBe("*");
    });

    test("echoes an exactly-listed origin", () => {
      expect(resolveAllowOrigin("https://example.com", ["example.com"])).toBe(
        "https://example.com",
      );
    });

    test("matches the origin host case-insensitively", () => {
      expect(resolveAllowOrigin("https://EXAMPLE.com", ["example.com"])).toBe(
        "https://EXAMPLE.com",
      );
    });

    test("ignores the origin port", () => {
      expect(
        resolveAllowOrigin("https://example.com:8443", ["example.com"]),
      ).toBe("https://example.com:8443");
    });

    test("matches a wildcard subdomain", () => {
      expect(
        resolveAllowOrigin("https://www.example.com", ["*.example.com"]),
      ).toBe("https://www.example.com");
    });

    test("wildcard does not match the bare apex", () => {
      expect(
        resolveAllowOrigin("https://example.com", ["*.example.com"]),
      ).toBeNull();
    });

    test("rejects an unlisted origin", () => {
      expect(
        resolveAllowOrigin("https://evil.com", ["example.com"]),
      ).toBeNull();
    });

    test("rejects a missing origin against a non-empty list", () => {
      expect(resolveAllowOrigin(null, ["example.com"])).toBeNull();
    });

    test("rejects a malformed origin", () => {
      expect(resolveAllowOrigin("not a url", ["example.com"])).toBeNull();
    });
  });

  describe("buildCatalog", () => {
    test("keys active non-hidden entries by slug, excludes hidden + inactive", () => {
      const catalog = buildCatalog({
        ...base,
        listings: [
          testListing({ id: 1, name: "Open", slug: "open", unit_price: 1500 }),
          testListing({ hidden: true, id: 2, name: "Secret", slug: "secret" }),
          testListing({ active: false, id: 3, name: "Closed", slug: "closed" }),
        ],
      });
      expect(Object.keys(catalog.listings)).toEqual(["open"]);
      expect(catalog.listings.open).toEqual({
        id: 1,
        name: "Open",
        slug: "open",
        unitPrice: 1500,
        variablePrice: false,
      });
      expect(catalog.origin).toBe("https://tickets.test");
      expect(catalog.currency).toBe("GBP");
      expect(catalog.decimalPlaces).toBe(2);
      expect(catalog.generatedAt).toBe("2026-06-28T20:00:00Z");
    });

    test("flags variablePrice for daily, customisable-days, and PWYW", () => {
      const catalog = buildCatalog({
        ...base,
        listings: [
          testListing({ id: 1, listing_type: "daily", slug: "daily" }),
          testListing({ customisable_days: true, id: 2, slug: "days" }),
          testListing({ can_pay_more: true, id: 3, slug: "pwyw" }),
          testListing({ id: 4, slug: "fixed" }),
        ],
      });
      expect(
        (catalog.listings.daily as { variablePrice: boolean }).variablePrice,
      ).toBe(true);
      expect(
        (catalog.listings.days as { variablePrice: boolean }).variablePrice,
      ).toBe(true);
      expect(
        (catalog.listings.pwyw as { variablePrice: boolean }).variablePrice,
      ).toBe(true);
      expect(
        (catalog.listings.fixed as { variablePrice: boolean }).variablePrice,
      ).toBe(false);
    });

    test("keys package bundles by slug, separate from listings", () => {
      const catalog = buildCatalog({
        ...base,
        listings: [testListing({ id: 1, name: "Solo", slug: "solo" })],
        packages: [
          { name: "Camp Bundle", slug: "camp" },
          { name: "Beach Bundle", slug: "beach" },
        ],
      });
      expect(Object.keys(catalog.listings)).toEqual(["solo"]);
      expect(catalog.packages).toEqual({
        beach: { name: "Beach Bundle", slug: "beach" },
        camp: { name: "Camp Bundle", slug: "camp" },
      });
    });

    test("defaults packages to an empty object when none are given", () => {
      const catalog = buildCatalog({ ...base, listings: [] });
      expect(catalog.packages).toEqual({});
    });
  });

  describe("serializeCatalog", () => {
    test("produces a CATALOG const that round-trips", () => {
      const catalog = buildCatalog({ ...base, listings: [] });
      const out = serializeCatalog(catalog);
      expect(out).toMatch(/^const CATALOG = \{/);
      const json = out.slice("const CATALOG = ".length, -1);
      expect(JSON.parse(json)).toEqual(catalog);
    });

    test("escapes < so a name cannot form a closing script tag", () => {
      const catalog = buildCatalog({
        ...base,
        listings: [
          testListing({ id: 1, name: "</script><img src=x>", slug: "x" }),
        ],
      });
      const out = serializeCatalog(catalog);
      expect(out).not.toContain("</script>");
      expect(out).toContain("\\u003c");
    });
  });
});
