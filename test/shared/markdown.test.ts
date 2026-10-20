import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { mergePageImageUrls } from "#db/images.ts";
import {
  isSafeUrl,
  isSimpleMarkdown,
  renderMarkdown,
  withoutLinksTo,
} from "#shared/markdown.ts";
import { withRequestContext } from "#test-utils/request-context.ts";

describe("markdown", () => {
  describe("renderMarkdown", () => {
    test("renders bold text", () => {
      const result = renderMarkdown("**bold**");
      assertStringIncludes(result, "<strong>bold</strong>");
    });

    test("renders italic text", () => {
      const result = renderMarkdown("*italic*");
      assertStringIncludes(result, "<em>italic</em>");
    });

    test("renders links", () => {
      const result = renderMarkdown("[click](https://example.com)");
      assertStringIncludes(result, '<a href="https://example.com">click</a>');
    });

    test("wraps text in paragraph tags", () => {
      const result = renderMarkdown("hello");
      assertStringIncludes(result, "<p>hello</p>");
    });

    test("renders multiple paragraphs", () => {
      const result = renderMarkdown("para1\n\npara2");
      assertStringIncludes(result, "<p>para1</p>");
      assertStringIncludes(result, "<p>para2</p>");
    });

    test("renders unordered lists", () => {
      const result = renderMarkdown("- item1\n- item2");
      assertStringIncludes(result, "<li>item1</li>");
      assertStringIncludes(result, "<li>item2</li>");
    });

    test("escapes raw HTML tags", () => {
      const result = renderMarkdown("<script>alert(1)</script>");
      assert(!result.includes("<script>"));
      assertStringIncludes(result, "&lt;script&gt;");
    });

    test("escapes inline HTML", () => {
      const result = renderMarkdown("text <b>bold</b> more");
      assert(!result.includes("<b>"));
      assertStringIncludes(result, "&lt;b&gt;");
    });

    test("strips javascript: URLs from links", () => {
      const result = renderMarkdown("[click](javascript:alert(1))");
      assert(!result.includes("javascript:"));
      assertStringIncludes(result, '<a href="">click</a>');
    });

    test("strips javascript: URLs regardless of case", () => {
      const result = renderMarkdown("[click](JavaScript:alert(1))");
      assert(!result.includes("avaScript:"));
      assertStringIncludes(result, '<a href="">click</a>');
    });

    test("strips data: URLs from images", () => {
      const result = renderMarkdown("![x](data:text/html,<script>)");
      assert(!result.includes("data:text/html"));
      assertStringIncludes(result, 'src=""');
    });

    test("keeps safe https links", () => {
      const result = renderMarkdown("[ok](https://example.com)");
      assertStringIncludes(result, '<a href="https://example.com">ok</a>');
    });

    test("keeps relative links", () => {
      const result = renderMarkdown("[home](/admin)");
      assertStringIncludes(result, '<a href="/admin">home</a>');
    });

    test("keeps mailto links", () => {
      const result = renderMarkdown("[mail](mailto:a@b.com)");
      assertStringIncludes(result, '<a href="mailto:a@b.com">mail</a>');
    });

    test("renders an img#N reference with the mapped URL", () => {
      const result = renderMarkdown(
        "![poster](img#7)",
        new Map([[7, "/img/abc"]]),
      );
      expect(result).toContain('<img src="/img/abc"');
      expect(result).toContain('alt="poster"');
    });

    test("renders an img#N reference with no table entry as an empty src", () => {
      const result = renderMarkdown("![poster](img#9)");
      expect(result).toContain('src=""');
      expect(result).toContain('alt="poster"');
    });

    test("strips an img#N reference when the mapped URL is unsafe", () => {
      const result = renderMarkdown(
        "![poster](img#7)",
        new Map([[7, "javascript:alert(1)"]]),
      );
      expect(result).not.toContain("javascript:");
      expect(result).toContain("poster");
    });
  });

  describe("isSafeUrl", () => {
    test("allows http, https, mailto, and tel schemes", () => {
      expect(isSafeUrl("https://example.com")).toBe(true);
      expect(isSafeUrl("http://example.com")).toBe(true);
      expect(isSafeUrl("mailto:a@b.com")).toBe(true);
      expect(isSafeUrl("tel:+15551234")).toBe(true);
    });

    test("allows scheme-less relative URLs", () => {
      expect(isSafeUrl("/admin/foo")).toBe(true);
      expect(isSafeUrl("#anchor")).toBe(true);
      expect(isSafeUrl("foo/bar")).toBe(true);
    });

    test("rejects javascript and data schemes", () => {
      expect(isSafeUrl("javascript:alert(1)")).toBe(false);
      expect(isSafeUrl("data:text/html,x")).toBe(false);
      expect(isSafeUrl("vbscript:msgbox")).toBe(false);
    });

    test("rejects schemes hidden behind control characters and whitespace", () => {
      expect(isSafeUrl("java\tscript:alert(1)")).toBe(false);
      expect(isSafeUrl(" javascript:alert(1)")).toBe(false);
    });
  });

  describe("isSimpleMarkdown", () => {
    test("true for plain text", () => {
      expect(isSimpleMarkdown("What is your T-shirt size?")).toBe(true);
    });

    test("true for plain text with a single line break", () => {
      expect(isSimpleMarkdown("Line 1\nLine 2")).toBe(true);
    });

    test("true for plain text surrounded by whitespace", () => {
      expect(isSimpleMarkdown("  hello  ")).toBe(true);
    });

    test("false for empty string", () => {
      expect(isSimpleMarkdown("")).toBe(false);
    });

    test("false for bold", () => {
      expect(isSimpleMarkdown("What is your **size**?")).toBe(false);
    });

    test("false for italic", () => {
      expect(isSimpleMarkdown("What is your *size*?")).toBe(false);
    });

    test("false for a link", () => {
      expect(isSimpleMarkdown("See [here](https://example.com)")).toBe(false);
    });

    test("false for inline code", () => {
      expect(isSimpleMarkdown("Use `code` here")).toBe(false);
    });

    test("false for a heading", () => {
      expect(isSimpleMarkdown("# Heading")).toBe(false);
    });

    test("false for a list", () => {
      expect(isSimpleMarkdown("- item1\n- item2")).toBe(false);
    });

    test("false for multiple paragraphs", () => {
      expect(isSimpleMarkdown("para1\n\npara2")).toBe(false);
    });

    test("false for a blockquote", () => {
      expect(isSimpleMarkdown("> quoted text")).toBe(false);
    });

    test("false for a table", () => {
      expect(
        isSimpleMarkdown("| Col1 | Col2 |\n|------|------|\n| a    | b    |"),
      ).toBe(false);
    });

    test("false for raw HTML", () => {
      expect(isSimpleMarkdown("text <b>bold</b> more")).toBe(false);
    });
  });
  describe("withoutLinksTo", () => {
    test("demotes a link matching the prefix to its plain text", () => {
      expect(
        withoutLinksTo(
          "Check the [ledger](/admin/ledger/attendee/5).",
          "/admin/ledger",
        ),
      ).toBe("Check the ledger.");
    });

    test("keeps links to other targets untouched", () => {
      const text = "See [the guide](/admin/guide) for details.";
      expect(withoutLinksTo(text, "/admin/ledger")).toBe(text);
    });

    test("handles several links, demoting only the matching ones", () => {
      expect(
        withoutLinksTo(
          "[a](/admin/ledger/x) then [b](/admin/guide) then [c](/admin/ledger)",
          "/admin/ledger",
        ),
      ).toBe("a then [b](/admin/guide) then c");
    });

    test("leaves plain text without links unchanged", () => {
      expect(withoutLinksTo("no links here", "/admin/ledger")).toBe(
        "no links here",
      );
    });

    test("demotes every reference link form without changing safe markdown", () => {
      const markdown = [
        "**Money links:** [inline](/admin/ledger/inline), [full][money], [collapsed][], and [shortcut].",
        "",
        "Safe [guide](/admin/guide) and *formatting* stay unchanged.",
        "",
        '[money]: /admin/ledger/full "Money"',
        "[collapsed]: /admin/ledger/collapsed",
        "[shortcut]: /admin/ledger/shortcut",
      ].join("\n");

      const filtered = withoutLinksTo(markdown, "/admin/ledger");

      expect(filtered).toBe(
        [
          "**Money links:** inline, full, collapsed, and shortcut.",
          "",
          "Safe [guide](/admin/guide) and *formatting* stay unchanged.",
          "",
          '[money]: /admin/ledger/full "Money"',
          "[collapsed]: /admin/ledger/collapsed",
          "[shortcut]: /admin/ledger/shortcut",
        ].join("\n"),
      );
      const rendered = renderMarkdown(filtered);
      assert(!rendered.includes('href="/admin/ledger'));
      assertStringIncludes(rendered, '<a href="/admin/guide">guide</a>');
      assertStringIncludes(rendered, "<strong>Money links:</strong>");
      assertStringIncludes(rendered, "<em>formatting</em>");
    });

    test("demotes automatic links to a forbidden absolute prefix", () => {
      expect(
        withoutLinksTo(
          "<https://private.example/one> and https://private.example/two",
          "https://private.example",
        ),
      ).toBe("https://private.example/one and https://private.example/two");
    });

    test("demotes forbidden links inside other markdown structures", () => {
      const markdown = [
        "- **See [money](/admin/ledger/list).**",
        "",
        "> [Account](/admin/ledger/account)",
        "",
        "| Page | Link |",
        "| --- | --- |",
        "| Money | [Open](/admin/ledger/table) |",
      ].join("\n");

      expect(withoutLinksTo(markdown, "/admin/ledger")).toBe(
        [
          "- **See money.**",
          "",
          "> Account",
          "",
          "| Page | Link |",
          "| --- | --- |",
          "| Money | Open |",
        ].join("\n"),
      );
    });

    test("preserves multiline quote and list syntax around forbidden links", () => {
      const markdown = [
        "> `[money](/admin/ledger/code)` stays code.",
        ">",
        "> [Money](/admin/ledger/quote) is restricted.",
        "",
        "- `[money](/admin/ledger/list-code)` stays code.",
        "  [Money](/admin/ledger/list) is restricted.",
      ].join("\n");

      expect(withoutLinksTo(markdown, "/admin/ledger")).toBe(
        [
          "> `[money](/admin/ledger/code)` stays code.",
          ">",
          "> Money is restricted.",
          "",
          "- `[money](/admin/ledger/list-code)` stays code.",
          "  Money is restricted.",
        ].join("\n"),
      );
    });

    test("preserves quoted table and list structure", () => {
      const markdown = [
        "> - [Money](/admin/ledger/list)",
        "",
        "> | Page |",
        "> | --- |",
        "> | [Money](/admin/ledger/table) |",
      ].join("\n");

      expect(withoutLinksTo(markdown, "/admin/ledger")).toBe(
        ["> - Money", "", "> | Page |", "> | --- |", "> | Money |"].join("\n"),
      );
    });

    test("does not crash on a table with escaped pipes and still demotes links in other cells", () => {
      // Marked normalizes `\|` to `|` in cell.text, so a cell with an escaped
      // pipe can't be located in token.raw. Before the fix this hit an assert
      // and crashed; now the unmatched cell is skipped (its raw source stays)
      // while matched cells are still rewritten.
      const markdown = [
        "| Link | Note |",
        "| --- | --- |",
        "| [money](/admin/ledger/x) | a\\|b |",
      ].join("\n");

      const filtered = withoutLinksTo(markdown, "/admin/ledger");
      expect(filtered).toBe(
        ["| Link | Note |", "| --- | --- |", "| money | a\\|b |"].join("\n"),
      );
    });

    test("demotes links matching a predicate, not just a string prefix", () => {
      // The attendee ledger tab (/admin/attendees/:id/ledger) is owner-only
      // but doesn't share a prefix with the standalone /admin/ledger routes.
      // A predicate matcher catches both.
      const isOwnerOnly = (href: string): boolean =>
        href.startsWith("/admin/ledger") ||
        (href.startsWith("/admin/attendees/") && href.includes("/ledger"));

      expect(
        withoutLinksTo(
          "See the [ledger](/admin/attendees/5/ledger).",
          isOwnerOnly,
        ),
      ).toBe("See the ledger.");
      // A link to the attendee page itself (not the ledger tab) is kept.
      expect(
        withoutLinksTo("See [Ada](/admin/attendees/5).", isOwnerOnly),
      ).toBe("See [Ada](/admin/attendees/5).");
    });
  });

  describe("short-form image references", () => {
    test("renders an img#id image through the image's uid URL", () => {
      const result = renderMarkdown(
        "![Hero](img#7)",
        new Map([[7, "/image/3f2a9c1e-7b44-4c0d-8e19-a2b3c4d5e6f7.webp"]]),
      );
      expect(result).toContain(
        '<img src="/image/3f2a9c1e-7b44-4c0d-8e19-a2b3c4d5e6f7.webp" alt="Hero">',
      );
    });

    test("renders no image source when the table lacks the id", () => {
      const result = renderMarkdown(
        "![Hero](img#7)",
        new Map([[9, "/image/other.webp"]]),
      );
      expect(result).toContain('<img src="" alt="Hero">');
      expect(result).not.toContain("/image/");
    });

    test("resolves an img#id reference from the request's page-image table", async () => {
      await withRequestContext(() => {
        mergePageImageUrls(new Map([[7, "/image/hero.webp"]]));
        expect(renderMarkdown("![Hero](img#7)")).toContain(
          '<img src="/image/hero.webp" alt="Hero">',
        );
      });
    });

    test("merges each page-image write into one table for the request", async () => {
      await withRequestContext(() => {
        mergePageImageUrls(new Map([[7, "/image/hero.webp"]]));
        mergePageImageUrls(new Map([[9, "/image/map.webp"]]));
        expect(renderMarkdown("![Hero](img#7)")).toContain(
          '<img src="/image/hero.webp" alt="Hero">',
        );
        expect(renderMarkdown("![Map](img#9)")).toContain(
          '<img src="/image/map.webp" alt="Map">',
        );
      });
    });

    test("renders no image source before any page-image write", async () => {
      await withRequestContext(() => {
        expect(renderMarkdown("![Hero](img#7)")).toContain(
          '<img src="" alt="Hero">',
        );
      });
    });

    test("keeps a page-image write outside a request a no-op", () => {
      mergePageImageUrls(new Map([[7, "/image/hero.webp"]]));
      expect(renderMarkdown("![Hero](img#7)")).toContain(
        '<img src="" alt="Hero">',
      );
    });

    test("keeps a img#id link target as the author wrote it", () => {
      const result = renderMarkdown("[docs](img#7)");
      expect(result).toContain('href="img#7"');
      expect(result).not.toContain("/image/");
    });

    test("leaves img#id references inside code spans alone", () => {
      const result = renderMarkdown("`![Hero](img#7)`");
      expect(result).toContain("<code>![Hero](img#7)</code>");
      expect(result).not.toContain("/image/");
    });

    test("leaves plain img#text prose alone", () => {
      const result = renderMarkdown("see img#7 for the poster");
      expect(result).toContain("<p>see img#7 for the poster</p>");
      expect(result).not.toContain("/image/");
    });
  });
});
