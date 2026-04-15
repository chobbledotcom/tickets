import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { enableQueryLog, runWithQueryLogContext } from "#lib/db/query-log.ts";
import {
  debugFooterHtml,
  renderDebugFooter,
} from "#templates/admin/footer.tsx";

describe("debugFooterHtml", () => {
  test("renders summary with render time", () => {
    const html = debugFooterHtml({
      cacheStats: [],
      queries: [],
      renderTimeMs: 42.7,
    });
    expect(html).toContain("43ms");
  });

  test("links to the GitHub repo", () => {
    const html = debugFooterHtml({
      cacheStats: [],
      queries: [],
      renderTimeMs: 10,
    });
    expect(html).toContain('href="https://github.com/chobbledotcom/tickets"');
    expect(html).toContain("Chobble Tickets</a>");
  });

  test("wraps content in a details/summary element", () => {
    const html = debugFooterHtml({
      cacheStats: [],
      queries: [],
      renderTimeMs: 10,
    });
    expect(html).toContain("<details>");
    expect(html).toContain("<summary>");
    expect(html).toContain("</summary>");
    expect(html).toContain("</details>");
  });

  test("renders inside a footer element", () => {
    const html = debugFooterHtml({
      cacheStats: [],
      queries: [],
      renderTimeMs: 10,
    });
    expect(html).toContain("<footer");
    expect(html).toContain("</footer>");
  });

  test("uses the debug-footer CSS class", () => {
    const html = debugFooterHtml({
      cacheStats: [],
      queries: [],
      renderTimeMs: 10,
    });
    expect(html).toContain('class="debug-footer"');
  });

  test("lists each query with its duration", () => {
    const html = debugFooterHtml({
      cacheStats: [],
      queries: [
        { durationMs: 5.2, sql: "SELECT * FROM events" },
        { durationMs: 3.1, sql: "SELECT * FROM users WHERE id = ?" },
      ],
      renderTimeMs: 20,
    });
    expect(html).toContain("SELECT * FROM events");
    expect(html).toContain("5.2ms");
    expect(html).toContain("SELECT * FROM users WHERE id = ?");
    expect(html).toContain("3.1ms");
  });

  test("escapes HTML in SQL strings", () => {
    const html = debugFooterHtml({
      cacheStats: [],
      queries: [{ durationMs: 1.0, sql: "SELECT '<script>' FROM t" }],
      renderTimeMs: 10,
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("renders empty query list gracefully", () => {
    const html = debugFooterHtml({
      cacheStats: [],
      queries: [],
      renderTimeMs: 5,
    });
    expect(html).toContain("0 queries");
    expect(html).not.toContain("SQL queries");
  });

  test("shows query count and total SQL time in summary", () => {
    const html = debugFooterHtml({
      cacheStats: [],
      queries: [
        { durationMs: 10, sql: "SELECT 1" },
        { durationMs: 15, sql: "SELECT 2" },
      ],
      renderTimeMs: 50,
    });
    expect(html).toContain("2 queries 25ms");
  });

  test("shows singular query for single query", () => {
    const html = debugFooterHtml({
      cacheStats: [],
      queries: [{ durationMs: 5, sql: "SELECT 1" }],
      renderTimeMs: 20,
    });
    expect(html).toContain("1 query 5ms");
  });

  test("shows render time breakdown with sql vs other", () => {
    const html = debugFooterHtml({
      cacheStats: [],
      queries: [
        { durationMs: 30, sql: "SELECT 1" },
        { durationMs: 20, sql: "SELECT 2" },
      ],
      renderTimeMs: 100,
    });
    expect(html).toContain("sql 50.0ms");
    expect(html).toContain("other 50.0ms");
  });

  test("shows cache stats section", () => {
    const html = debugFooterHtml({
      cacheStats: [
        { entries: 3, name: "sessions" },
        { capacity: 10000, entries: 150, name: "decrypt" },
      ],
      queries: [],
      renderTimeMs: 10,
    });
    expect(html).toContain("Caches (2)");
    expect(html).toContain("sessions: 3");
    expect(html).toContain("decrypt: 150/10000");
  });

  test("shows total cached entries in summary", () => {
    const html = debugFooterHtml({
      cacheStats: [
        { entries: 5, name: "users" },
        { entries: 10, name: "events" },
      ],
      queries: [],
      renderTimeMs: 10,
    });
    expect(html).toContain("15 cached");
  });

  test("omits cache section when no caches registered", () => {
    const html = debugFooterHtml({
      cacheStats: [],
      queries: [],
      renderTimeMs: 10,
    });
    expect(html).not.toContain("Caches");
  });

  test("escapes HTML in cache names", () => {
    const html = debugFooterHtml({
      cacheStats: [{ entries: 1, name: "<script>" }],
      queries: [],
      renderTimeMs: 10,
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("renderDebugFooter", () => {
  test("returns empty string when query logging is not active", () => {
    runWithQueryLogContext(() => {
      expect(renderDebugFooter()).toBe("");
    });
  });

  test("returns footer HTML when query logging is active", () => {
    runWithQueryLogContext(() => {
      enableQueryLog();
      const html = renderDebugFooter();
      expect(html).toContain('<footer class="debug-footer">');
      expect(html).toContain("Chobble Tickets");
      expect(html).toContain("ms");
    });
  });
});
