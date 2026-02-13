import { describe, expect, test } from "#test-compat";
import {
  buildEmbedCode,
  buildEmbedTemplate,
  computeIframeHeight,
  EMBED_URL_PLACEHOLDER,
} from "#lib/embed.ts";

describe("embed", () => {
  describe("computeIframeHeight", () => {
    test("returns 14rem for empty fields (name only)", () => {
      expect(computeIframeHeight("")).toBe("14rem");
    });

    test("returns 18rem for email-only", () => {
      expect(computeIframeHeight("email")).toBe("18rem");
    });

    test("returns 18rem for phone-only", () => {
      expect(computeIframeHeight("phone")).toBe("18rem");
    });

    test("returns 22rem for email,phone", () => {
      expect(computeIframeHeight("email,phone")).toBe("22rem");
    });

    test("returns 20rem for address-only (textarea)", () => {
      expect(computeIframeHeight("address")).toBe("20rem");
    });

    test("returns 20rem for special_instructions-only (textarea)", () => {
      expect(computeIframeHeight("special_instructions")).toBe("20rem");
    });

    test("returns 28rem for email,phone,address", () => {
      expect(computeIframeHeight("email,phone,address")).toBe("28rem");
    });

    test("returns 34rem for all four fields", () => {
      expect(computeIframeHeight("email,phone,address,special_instructions")).toBe("34rem");
    });
  });

  describe("buildEmbedTemplate", () => {
    test("produces iframe with placeholder URL and computed height", () => {
      const result = buildEmbedTemplate("email");
      expect(result).toContain(`${EMBED_URL_PLACEHOLDER}?iframe=true`);
      expect(result).toContain("height: 18rem");
      expect(result).toContain("loading=\"lazy\"");
    });

    test("uses height from fields setting", () => {
      const result = buildEmbedTemplate("email,phone,address");
      expect(result).toContain("height: 28rem");
    });
  });

  describe("buildEmbedCode", () => {
    test("replaces placeholder with actual url", () => {
      const result = buildEmbedCode("https://example.com/ticket/test", "email");
      expect(result).toBe(
        '<iframe src="https://example.com/ticket/test?iframe=true" loading="lazy" style="border: none; width: 100%; height: 18rem">Loading..</iframe>',
      );
      expect(result).not.toContain(EMBED_URL_PLACEHOLDER);
    });

    test("uses height from merged fields", () => {
      const result = buildEmbedCode("https://example.com/ticket/a+b", "email,phone,address");
      expect(result).toContain("height: 28rem");
      expect(result).toContain("https://example.com/ticket/a+b?iframe=true");
    });
  });
});
