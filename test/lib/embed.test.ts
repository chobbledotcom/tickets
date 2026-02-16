import { describe, expect, test } from "#test-compat";
import { buildEmbedSnippets } from "#lib/embed.ts";

describe("embed", () => {
  describe("buildEmbedSnippets", () => {
    test("script variant is a single script tag with data-events", () => {
      const result = buildEmbedSnippets("https://example.com/ticket/test");
      expect(result.script).toBe('<script async src="https://example.com/embed.js" data-events="test"></script>');
    });

    test("iframe variant is a plain iframe without resizer scripts", () => {
      const result = buildEmbedSnippets("https://example.com/ticket/test");
      expect(result.iframe).toBe(
        '<iframe src="https://example.com/ticket/test?iframe=true" loading="lazy" style="border: none; width: 100%; height: 600px;">Loading..</iframe>',
      );
    });

    test("uses plus-delimited slugs in data-events and iframe src", () => {
      const result = buildEmbedSnippets("https://example.com/ticket/a+b");
      expect(result.script).toContain('data-events="a+b"');
      expect(result.iframe).toContain("https://example.com/ticket/a+b?iframe=true");
    });

    test("extracts origin correctly for embed script URL", () => {
      const result = buildEmbedSnippets("https://tickets.mysite.org/ticket/test");
      expect(result.script).toContain('src="https://tickets.mysite.org/embed.js"');
    });

    test("handles non-ticket URLs by emitting empty data-events", () => {
      const result = buildEmbedSnippets("https://example.com/");
      expect(result.script).toContain('data-events=""');
    });
  });
});
