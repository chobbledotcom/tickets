import { describe, expect, test } from "#test-compat";
import { ownerFooterHtml } from "#templates/admin/footer.tsx";

describe("ownerFooterHtml", () => {
  test("renders summary with render time", () => {
    const html = ownerFooterHtml(42.7, []);
    expect(html).toContain("43ms");
  });

  test("links to the GitHub repo", () => {
    const html = ownerFooterHtml(10, []);
    expect(html).toContain('href="https://github.com/chobbledotcom/tickets"');
    expect(html).toContain("Chobble Tickets</a>");
  });

  test("wraps content in a details/summary element", () => {
    const html = ownerFooterHtml(10, []);
    expect(html).toContain("<details>");
    expect(html).toContain("<summary>");
    expect(html).toContain("</summary>");
    expect(html).toContain("</details>");
  });

  test("renders inside a footer element", () => {
    const html = ownerFooterHtml(10, []);
    expect(html).toContain("<footer");
    expect(html).toContain("</footer>");
  });

  test("uses the debug-footer CSS class", () => {
    const html = ownerFooterHtml(10, []);
    expect(html).toContain('class="debug-footer"');
  });

  test("lists each query with its duration", () => {
    const html = ownerFooterHtml(20, [
      { sql: "SELECT * FROM events", durationMs: 5.2 },
      { sql: "SELECT * FROM users WHERE id = ?", durationMs: 3.1 },
    ]);
    expect(html).toContain("SELECT * FROM events");
    expect(html).toContain("5.2ms");
    expect(html).toContain("SELECT * FROM users WHERE id = ?");
    expect(html).toContain("3.1ms");
  });

  test("escapes HTML in SQL strings", () => {
    const html = ownerFooterHtml(10, [
      { sql: "SELECT '<script>' FROM t", durationMs: 1.0 },
    ]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("renders empty query list gracefully", () => {
    const html = ownerFooterHtml(5, []);
    expect(html).toContain("<ul");
    expect(html).toContain("</ul>");
    expect(html).not.toContain("<li>");
  });
});
