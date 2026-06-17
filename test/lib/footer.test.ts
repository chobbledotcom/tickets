import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import {
  enableFooterDebug,
  runWithQueryLogContext,
} from "#shared/db/query-log.ts";
import {
  adminFooterHtml,
  debugDetailsHtml,
  markAdminFooter,
  renderAdminFooter,
} from "#templates/admin/footer.tsx";
import { setupTestEncryptionKey } from "#test-utils";

beforeAll(async () => {
  // The footer's logout form embeds the current CSRF token, which is HMAC
  // signed with the encryption key.
  setupTestEncryptionKey();
  await signCsrfToken();
});

describe("debugDetailsHtml", () => {
  test("renders summary with render time", () => {
    const html = debugDetailsHtml({
      cacheStats: [],
      queries: [],
      renderTimeMs: 42.7,
      uptimeSeconds: 0,
    });
    expect(html).toContain("43ms");
  });

  test("wraps content in a details/summary element", () => {
    const html = debugDetailsHtml({
      cacheStats: [],
      queries: [],
      renderTimeMs: 10,
      uptimeSeconds: 0,
    });
    expect(html).toContain("<details");
    expect(html).toContain("<summary>");
    expect(html).toContain("</summary>");
    expect(html).toContain("</details>");
  });

  test("lists each query with its duration", () => {
    const html = debugDetailsHtml({
      cacheStats: [],
      queries: [
        { durationMs: 5.2, sql: "SELECT * FROM listings" },
        { durationMs: 3.1, sql: "SELECT * FROM users WHERE id = ?" },
      ],
      renderTimeMs: 20,
      uptimeSeconds: 0,
    });
    expect(html).toContain("SELECT * FROM listings");
    expect(html).toContain("5.2ms");
    expect(html).toContain("SELECT * FROM users WHERE id = ?");
    expect(html).toContain("3.1ms");
  });

  test("escapes HTML in SQL strings", () => {
    const html = debugDetailsHtml({
      cacheStats: [],
      queries: [{ durationMs: 1.0, sql: "SELECT '<script>' FROM t" }],
      renderTimeMs: 10,
      uptimeSeconds: 0,
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("renders empty query list gracefully", () => {
    const html = debugDetailsHtml({
      cacheStats: [],
      queries: [],
      renderTimeMs: 5,
      uptimeSeconds: 0,
    });
    expect(html).toContain("0 queries");
    expect(html).not.toContain("SQL queries");
  });

  test("shows query count and total SQL time in summary", () => {
    const html = debugDetailsHtml({
      cacheStats: [],
      queries: [
        { durationMs: 10, sql: "SELECT 1" },
        { durationMs: 15, sql: "SELECT 2" },
      ],
      renderTimeMs: 50,
      uptimeSeconds: 0,
    });
    expect(html).toContain("2 queries 25ms");
  });

  test("shows singular query for single query", () => {
    const html = debugDetailsHtml({
      cacheStats: [],
      queries: [{ durationMs: 5, sql: "SELECT 1" }],
      renderTimeMs: 20,
      uptimeSeconds: 0,
    });
    expect(html).toContain("1 query 5ms");
  });

  test("shows render time breakdown with sql vs other", () => {
    const html = debugDetailsHtml({
      cacheStats: [],
      queries: [
        { durationMs: 30, sql: "SELECT 1" },
        { durationMs: 20, sql: "SELECT 2" },
      ],
      renderTimeMs: 100,
      uptimeSeconds: 0,
    });
    expect(html).toContain("sql 50.0ms");
    expect(html).toContain("other 50.0ms");
  });

  test("shows cache stats section", () => {
    const html = debugDetailsHtml({
      cacheStats: [
        { entries: 3, name: "sessions" },
        { capacity: 10000, entries: 150, name: "decrypt" },
      ],
      queries: [],
      renderTimeMs: 10,
      uptimeSeconds: 0,
    });
    expect(html).toContain("Caches (2)");
    expect(html).toContain("sessions: 3");
    expect(html).toContain("decrypt: 150/10000");
  });

  test("shows total cached entries in summary", () => {
    const html = debugDetailsHtml({
      cacheStats: [
        { entries: 5, name: "users" },
        { entries: 10, name: "listings" },
      ],
      queries: [],
      renderTimeMs: 10,
      uptimeSeconds: 0,
    });
    expect(html).toContain("15 cached");
  });

  test("omits cache section when no caches registered", () => {
    const html = debugDetailsHtml({
      cacheStats: [],
      queries: [],
      renderTimeMs: 10,
      uptimeSeconds: 0,
    });
    expect(html).not.toContain("Caches");
  });

  test("escapes HTML in cache names", () => {
    const html = debugDetailsHtml({
      cacheStats: [{ entries: 1, name: "<script>" }],
      queries: [],
      renderTimeMs: 10,
      uptimeSeconds: 0,
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("shows app uptime in whole seconds in the summary", () => {
    const html = debugDetailsHtml({
      cacheStats: [],
      queries: [],
      renderTimeMs: 10,
      uptimeSeconds: 1234.7,
    });
    expect(html).toContain("up 1235s");
  });
});

describe("adminFooterHtml", () => {
  test("renders a footer with the admin-footer class", () => {
    const html = adminFooterHtml(null);
    expect(html).toContain('<footer class="admin-footer">');
    expect(html).toContain("</footer>");
  });

  test("links to the GitHub repo", () => {
    const html = adminFooterHtml(null);
    expect(html).toContain('href="https://github.com/chobbledotcom/tickets"');
    expect(html).toContain("Chobble Tickets</a>");
  });

  test("includes a logout form", () => {
    const html = adminFooterHtml(null);
    expect(html).toContain('action="/admin/logout"');
  });

  test("omits the debug menu when no debug data is supplied", () => {
    const html = adminFooterHtml(null);
    expect(html).not.toContain("debug-menu");
  });

  test("includes the debug menu when debug data is supplied", () => {
    const html = adminFooterHtml({
      cacheStats: [],
      queries: [],
      renderTimeMs: 12,
      uptimeSeconds: 0,
    });
    expect(html).toContain("debug-menu");
    expect(html).toContain("12ms");
  });
});

describe("renderAdminFooter", () => {
  test("returns empty string when the page was not flagged as admin", () => {
    runWithQueryLogContext(() => {
      expect(renderAdminFooter()).toBe("");
    });
  });

  test("renders the footer with logout once flagged, with no debug menu when query logging is off", () => {
    runWithQueryLogContext(() => {
      markAdminFooter();
      const html = renderAdminFooter();
      expect(html).toContain('<footer class="admin-footer">');
      expect(html).toContain('action="/admin/logout"');
      expect(html).not.toContain("debug-menu");
    });
  });

  test("consumes the flag so a later render is empty", () => {
    runWithQueryLogContext(() => {
      markAdminFooter();
      renderAdminFooter();
      expect(renderAdminFooter()).toBe("");
    });
  });

  test("includes the debug menu and uptime when footer debug is enabled", () => {
    runWithQueryLogContext(() => {
      enableFooterDebug();
      markAdminFooter();
      const html = renderAdminFooter();
      expect(html).toContain("debug-menu");
      expect(html).toMatch(/up \d+s/);
    });
  });
});
