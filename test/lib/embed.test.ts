import { describe, expect, test } from "#test-compat";
import { buildEmbedCode, computeIframeHeight } from "#lib/embed.ts";

describe("embed", () => {
  describe("computeIframeHeight", () => {
    test("returns 11rem for empty fields (name only)", () => {
      expect(computeIframeHeight("")).toBe("11rem");
    });

    test("returns 15rem for email-only", () => {
      expect(computeIframeHeight("email")).toBe("15rem");
    });

    test("returns 15rem for phone-only", () => {
      expect(computeIframeHeight("phone")).toBe("15rem");
    });

    test("returns 19rem for email,phone", () => {
      expect(computeIframeHeight("email,phone")).toBe("19rem");
    });

    test("returns 17rem for address-only (textarea)", () => {
      expect(computeIframeHeight("address")).toBe("17rem");
    });

    test("returns 17rem for special_instructions-only (textarea)", () => {
      expect(computeIframeHeight("special_instructions")).toBe("17rem");
    });

    test("returns 25rem for email,phone,address", () => {
      expect(computeIframeHeight("email,phone,address")).toBe("25rem");
    });

    test("returns 31rem for all four fields", () => {
      expect(computeIframeHeight("email,phone,address,special_instructions")).toBe("31rem");
    });
  });

  describe("buildEmbedCode", () => {
    test("produces iframe with url, iframe param, and computed height", () => {
      const result = buildEmbedCode("https://example.com/ticket/test", "email");
      expect(result).toBe(
        '<iframe src="https://example.com/ticket/test?iframe=true" loading="lazy" style="border: none; width: 100%; height: 15rem">Loading..</iframe>',
      );
    });

    test("uses height from merged fields", () => {
      const result = buildEmbedCode("https://example.com/ticket/a+b", "email,phone,address");
      expect(result).toContain("height: 25rem");
      expect(result).toContain("https://example.com/ticket/a+b?iframe=true");
    });
  });
});
