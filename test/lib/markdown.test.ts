import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  isSafeUrl,
  isSimpleMarkdown,
  renderMarkdown,
} from "#shared/markdown.ts";

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

    test("strips javascript: URLs from links", () => {
      const result = renderMarkdown("[click](javascript:alert(1))");
      expect(result).not.toContain("javascript:");
      expect(result).toContain('<a href="">click</a>');
    });

    test("strips javascript: URLs regardless of case", () => {
      const result = renderMarkdown("[click](JavaScript:alert(1))");
      expect(result).not.toContain("avaScript:");
      expect(result).toContain('<a href="">click</a>');
    });

    test("strips data: URLs from images", () => {
      const result = renderMarkdown("![x](data:text/html,<script>)");
      expect(result).not.toContain("data:text/html");
      expect(result).toContain('src=""');
    });

    test("keeps safe https links", () => {
      const result = renderMarkdown("[ok](https://example.com)");
      expect(result).toContain('<a href="https://example.com">ok</a>');
    });

    test("keeps relative links", () => {
      const result = renderMarkdown("[home](/admin)");
      expect(result).toContain('<a href="/admin">home</a>');
    });

    test("keeps mailto links", () => {
      const result = renderMarkdown("[mail](mailto:a@b.com)");
      expect(result).toContain('<a href="mailto:a@b.com">mail</a>');
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
});
