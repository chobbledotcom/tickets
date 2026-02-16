import { describe, expect, test } from "#test-compat";
import { buildEmbedSnippets } from "#lib/embed.ts";

describe("embed", () => {
  describe("buildEmbedSnippets", () => {
    test("produces script and iframe variants", () => {
      const result = buildEmbedSnippets("https://example.com/ticket/test");
      expect(result.script).toContain('<script async src="https://example.com/embed.js"');
      expect(result.script).toContain('data-events="test"');
      expect(result.script).toContain('data-resizer-src="https://example.com/iframe-resizer-parent.js"');
      expect(result.iframe).toContain('<script src="https://example.com/iframe-resizer-parent.js"></script>');
      expect(result.iframe).toContain('<iframe src="https://example.com/ticket/test?iframe=true"');
      expect(result.iframe).toContain('style="border: none; width: 100%; height: 600px;"');
    });

    test("uses plus-delimited slugs in data-events and iframe src", () => {
      const result = buildEmbedSnippets("https://example.com/ticket/a+b");
      expect(result.script).toContain('data-events="a+b"');
      expect(result.iframe).toContain("https://example.com/ticket/a+b?iframe=true");
    });

    test("extracts origin correctly for script and parent script URLs", () => {
      const result = buildEmbedSnippets("https://tickets.mysite.org/ticket/test");
      expect(result.script).toContain('src="https://tickets.mysite.org/embed.js"');
      expect(result.iframe).toContain('src="https://tickets.mysite.org/iframe-resizer-parent.js"');
    });

    test("handles non-ticket URLs by emitting empty data-events", () => {
      const result = buildEmbedSnippets("https://example.com/");
      expect(result.script).toContain('data-events=""');
    });

  });
});
