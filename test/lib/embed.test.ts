import { describe, expect, test } from "#test-compat";
import { buildIframeEmbedCode, buildScriptEmbedCode, computeIframeHeight } from "#lib/embed.ts";

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

  describe("buildScriptEmbedCode", () => {
    test("produces async script tag with data-events", () => {
      const result = buildScriptEmbedCode("https://example.com/ticket/test");
      expect(result).toBe('<script async src="https://example.com/embed.js" data-events="test"></script>');
    });

    test("extracts origin correctly for script URL", () => {
      const result = buildScriptEmbedCode("https://tickets.mysite.org/ticket/test");
      expect(result).toContain('src="https://tickets.mysite.org/embed.js"');
    });

    test("handles multi-event slugs with plus separator", () => {
      const result = buildScriptEmbedCode("https://example.com/ticket/a+b+c");
      expect(result).toContain('data-events="a+b+c"');
    });
  });

  describe("buildIframeEmbedCode", () => {
    test("produces iframe tag with computed height", () => {
      const result = buildIframeEmbedCode("https://example.com/ticket/test", "email");
      expect(result).toContain('<iframe src="https://example.com/ticket/test?iframe=true"');
      expect(result).toContain("height: 15rem");
      expect(result).toContain("loading=");
      expect(result).toContain("border: none");
      expect(result).toContain("width: 100%");
    });

    test("uses height from fields", () => {
      const result = buildIframeEmbedCode("https://example.com/ticket/a+b", "email,phone,address");
      expect(result).toContain("height: 25rem");
      expect(result).toContain("https://example.com/ticket/a+b?iframe=true");
    });

    test("does not include iframe-resizer scripts", () => {
      const result = buildIframeEmbedCode("https://example.com/ticket/test", "");
      expect(result).not.toContain("iframe-resizer");
      expect(result).not.toContain("iframeResize");
    });
  });
});
