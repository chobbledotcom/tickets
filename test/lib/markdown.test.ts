import { describe, expect, test } from "#test-compat";
import { renderMarkdown, renderMarkdownInline } from "#lib/markdown.ts";

describe("markdown", () => {
  describe("renderMarkdown", () => {
    test("renders bold text", () => {
      const result = renderMarkdown("**bold**");
      expect(result).toContain("<strong>bold</strong>");
    });

    test("renders italic text", () => {
      const result = renderMarkdown("*italic*");
      expect(result).toContain("<em>italic</em>");
    });

    test("renders links", () => {
      const result = renderMarkdown("[click](https://example.com)");
      expect(result).toContain('<a href="https://example.com">click</a>');
    });

    test("wraps text in paragraph tags", () => {
      const result = renderMarkdown("hello");
      expect(result).toContain("<p>hello</p>");
    });

    test("renders multiple paragraphs", () => {
      const result = renderMarkdown("para1\n\npara2");
      expect(result).toContain("<p>para1</p>");
      expect(result).toContain("<p>para2</p>");
    });

    test("renders unordered lists", () => {
      const result = renderMarkdown("- item1\n- item2");
      expect(result).toContain("<li>item1</li>");
      expect(result).toContain("<li>item2</li>");
    });

    test("escapes raw HTML tags", () => {
      const result = renderMarkdown("<script>alert(1)</script>");
      expect(result).not.toContain("<script>");
      expect(result).toContain("&lt;script&gt;");
    });

    test("escapes inline HTML", () => {
      const result = renderMarkdown("text <b>bold</b> more");
      expect(result).not.toContain("<b>");
      expect(result).toContain("&lt;b&gt;");
    });
  });

  describe("renderMarkdownInline", () => {
    test("renders bold text without wrapping paragraph", () => {
      const result = renderMarkdownInline("**bold**");
      expect(result).toBe("<strong>bold</strong>");
    });

    test("renders italic text", () => {
      const result = renderMarkdownInline("*italic*");
      expect(result).toBe("<em>italic</em>");
    });

    test("renders links", () => {
      const result = renderMarkdownInline("[click](https://example.com)");
      expect(result).toContain('<a href="https://example.com">click</a>');
    });

    test("does not wrap in paragraph tags", () => {
      const result = renderMarkdownInline("hello");
      expect(result).not.toContain("<p>");
      expect(result).toBe("hello");
    });

    test("renders plain text unchanged", () => {
      const result = renderMarkdownInline("simple text");
      expect(result).toBe("simple text");
    });
  });
});
