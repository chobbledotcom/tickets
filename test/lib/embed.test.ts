import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { buildEmbedSnippets } from "#shared/embed.ts";

describe("embed", () => {
  describe("buildEmbedSnippets", () => {
    test("script variant is a single script tag with data-listings", () => {
      const result = buildEmbedSnippets("https://example.com/ticket/test");
      expect(result.script).toBe(
        '<script async src="https://example.com/embed.js" data-listings="test"></script>',
      );
    });

    test("iframe variant is a plain iframe without resizer scripts", () => {
      const result = buildEmbedSnippets("https://example.com/ticket/test");
      expect(result.iframe).toBe(
        '<iframe src="https://example.com/ticket/test?iframe=true" loading="lazy" style="border: none; width: 100%; height: 600px;">Loading..</iframe>',
      );
    });

    test("uses plus-delimited slugs in data-listings and iframe src", () => {
      const result = buildEmbedSnippets("https://example.com/ticket/a+b");
      expect(result.script).toContain('data-listings="a+b"');
      expect(result.iframe).toContain(
        "https://example.com/ticket/a+b?iframe=true",
      );
    });

    test("extracts origin correctly for embed script URL", () => {
      const result = buildEmbedSnippets(
        "https://tickets.mysite.org/ticket/test",
      );
      expect(result.script).toContain(
        'src="https://tickets.mysite.org/embed.js"',
      );
    });

    test("handles non-ticket URLs by emitting empty data-listings", () => {
      const result = buildEmbedSnippets("https://example.com/");
      expect(result.script).toContain('data-listings=""');
    });
  });
});
