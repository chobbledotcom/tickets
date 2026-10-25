import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { enableFooterDebug } from "#db/query-log.ts";
import {
  adminFooterHtml,
  type DebugFooterData,
  debugDetailsHtml,
  markAdminFooter,
  renderAdminFooter,
} from "#templates/admin/footer.tsx";
import { expectHtmlEscaped } from "#test-utils/assertions.ts";
import { withRequestContext } from "#test-utils/request-context.ts";

describe("admin footer templates", () => {
  describe("debugDetailsHtml", () => {
    const renderDebug = (
      options: Partial<DebugFooterData> & { renderTimeMs: number },
    ): string =>
      debugDetailsHtml({
        cacheStats: [],
        queries: [],
        uptimeSeconds: 0,
        ...options,
      });

    const sequentialQueries: DebugFooterData["queries"] = [
      { durationMs: 10, sql: "SELECT 1", startedAtMs: 0 },
      { durationMs: 15, sql: "SELECT 2", startedAtMs: 20 },
    ];

    const overlappingQueries: DebugFooterData["queries"] = [
      { durationMs: 30, sql: "SELECT 1", startedAtMs: 0 },
      { durationMs: 30, sql: "SELECT 2", startedAtMs: 5 },
    ];

    const bareHtml = renderDebug({ renderTimeMs: 10 });
    const sequentialHtml = renderDebug({
      queries: sequentialQueries,
      renderTimeMs: 50,
    });
    const overlappingHtml = renderDebug({
      queries: overlappingQueries,
      renderTimeMs: 40,
    });

    test("renders summary with render time", () => {
      const html = renderDebug({ renderTimeMs: 42.7 });
      assertStringIncludes(html, "43ms");
    });

    test("wraps content in a details/summary element", () => {
      assertStringIncludes(bareHtml, "<details");
      assertStringIncludes(bareHtml, "<summary>");
      assertStringIncludes(bareHtml, "</summary>");
      assertStringIncludes(bareHtml, "</details>");
    });

    test("lists each query with its duration", () => {
      const html = renderDebug({
        queries: [
          { durationMs: 5.2, sql: "SELECT * FROM listings", startedAtMs: 0 },
          {
            durationMs: 3.1,
            sql: "SELECT * FROM users WHERE id = ?",
            startedAtMs: 10,
          },
        ],
        renderTimeMs: 20,
      });
      assertStringIncludes(html, "SELECT * FROM listings");
      assertStringIncludes(html, "5.2ms");
      assertStringIncludes(html, "SELECT * FROM users WHERE id = ?");
      assertStringIncludes(html, "3.1ms");
    });

    test("escapes HTML in SQL strings", () => {
      const html = renderDebug({
        queries: [
          { durationMs: 1.0, sql: "SELECT '<script>' FROM t", startedAtMs: 0 },
        ],
        renderTimeMs: 10,
      });
      expectHtmlEscaped(html);
    });

    test("renders empty query list gracefully", () => {
      const html = renderDebug({ renderTimeMs: 5 });
      assertStringIncludes(html, "0 queries");
      assert(!html.includes("SQL queries"));
    });

    test("summary SQL time is the wall-clock union, not the sum of durations", () => {
      // Two sequential (disjoint) queries: union 10+15 = 25ms.
      assertStringIncludes(sequentialHtml, "2 queries 25ms");
    });

    test("summary counts concurrent queries' overlap only once", () => {
      // Two queries overlapping in wall-clock time: union [0,15] = 15ms, even
      // though the durations sum to 25ms. The summary reports the honest 15ms.
      const html = renderDebug({
        queries: [
          { durationMs: 10, sql: "SELECT 1", startedAtMs: 0 },
          { durationMs: 10, sql: "SELECT 2", startedAtMs: 5 },
        ],
        renderTimeMs: 50,
      });
      assertStringIncludes(html, "2 queries 15ms");
    });

    test("shows singular query for single query", () => {
      const html = renderDebug({
        queries: [{ durationMs: 5, sql: "SELECT 1", startedAtMs: 0 }],
        renderTimeMs: 20,
      });
      assertStringIncludes(html, "1 query 5ms");
    });

    test("breakdown splits render into wall-clock sql and other", () => {
      // Disjoint queries → wall-clock sql 50ms, leaving other 50ms of 100ms.
      const html = renderDebug({
        queries: [
          { durationMs: 30, sql: "SELECT 1", startedAtMs: 0 },
          { durationMs: 20, sql: "SELECT 2", startedAtMs: 30 },
        ],
        renderTimeMs: 100,
      });
      assertStringIncludes(html, "sql 50.0ms");
      assertStringIncludes(html, "other 50.0ms");
    });

    test("breakdown keeps other non-negative when queries overlap", () => {
      // Durations sum to 60ms but only 35ms of wall-clock ([0,35]); without the
      // union, other would be render − 60 = −10ms. With it, other is 5ms.
      assertStringIncludes(overlappingHtml, "sql 35.0ms");
      assertStringIncludes(overlappingHtml, "other 5.0ms");
    });

    test("reports total query work and the parallel factor", () => {
      // 60ms of work folded into 35ms wall-clock → 60/35 ≈ 1.7×.
      assertStringIncludes(overlappingHtml, "60.0ms work across 2 queries");
      assertStringIncludes(overlappingHtml, "1.7&times; parallel");
    });

    test("reports a 1.0x parallel factor for sequential queries", () => {
      assertStringIncludes(sequentialHtml, "25.0ms work across 2 queries");
      assertStringIncludes(sequentialHtml, "1.0&times; parallel");
    });

    test("omits the SQL work line when there are no queries", () => {
      assert(!bareHtml.includes("parallel"));
    });

    test("shows cache stats section", () => {
      const html = renderDebug({
        cacheStats: [
          { entries: 3, name: "sessions" },
          { capacity: 10000, entries: 150, name: "decrypt" },
        ],
        renderTimeMs: 10,
      });
      assertStringIncludes(html, "Caches (2)");
      assertStringIncludes(html, "sessions: 3");
      assertStringIncludes(html, "decrypt: 150/10000");
    });

    test("shows total cached entries in summary", () => {
      const html = renderDebug({
        cacheStats: [
          { entries: 5, name: "users" },
          { entries: 10, name: "listings" },
        ],
        renderTimeMs: 10,
      });
      assertStringIncludes(html, "15 cached");
    });

    test("omits cache section when no caches registered", () => {
      assert(!bareHtml.includes("Caches"));
    });

    test("escapes HTML in cache names", () => {
      const html = renderDebug({
        cacheStats: [{ entries: 1, name: "<script>" }],
        renderTimeMs: 10,
      });
      expectHtmlEscaped(html);
    });

    test("shows app uptime in whole seconds in the summary", () => {
      const html = renderDebug({
        renderTimeMs: 10,
        uptimeSeconds: 1234.7,
      });
      assertStringIncludes(html, "up 1235s");
    });
  });

  describe("adminFooterHtml", () => {
    test("renders a footer with the admin-footer class", () => {
      const html = adminFooterHtml(null, "owner");
      assertStringIncludes(html, '<footer class="admin-footer">');
      assertStringIncludes(html, "</footer>");
    });

    test("links to the GitHub repo", () => {
      const html = adminFooterHtml(null, "owner");
      assertStringIncludes(
        html,
        'href="https://github.com/chobbledotcom/tickets"',
      );
      assertStringIncludes(html, "Chobble Tickets</a>");
    });

    test("wraps the Chobble link in a span so it doesn't stretch the row", () => {
      const html = adminFooterHtml(null, "owner");
      assertStringIncludes(
        html,
        '<span class="admin-footer-brand"><a href="https://github.com/chobbledotcom/tickets">Chobble Tickets</a></span>',
      );
    });

    test("staff see log, guide, and logout links separated by dots", () => {
      const html = adminFooterHtml(null, "owner");
      assertStringIncludes(html, '<div class="admin-footer-links">');
      assertStringIncludes(
        html,
        '<a href="/admin/log">Log</a> &middot; <a href="/admin/guide">Guide</a> &middot; <a href="/admin/logout">Log out</a>',
      );
      assert(!html.includes('action="/admin/logout"'));
      assert(!html.includes("#log-out"));
    });

    test("editors get only logout (log and guide are staff-only)", () => {
      const html = adminFooterHtml(null, "editor");
      assert(!html.includes('href="/admin/log"'));
      assert(!html.includes('href="/admin/guide"'));
      assertStringIncludes(html, '<a href="/admin/logout">Log out</a>');
    });

    test("delivery agents get only logout (no log or guide they can't open)", () => {
      const html = adminFooterHtml(null, "agent");
      assert(!html.includes('href="/admin/log"'));
      assert(!html.includes('href="/admin/guide"'));
      assertStringIncludes(html, '<a href="/admin/logout">Log out</a>');
    });

    test("omits the debug menu when no debug data is supplied", () => {
      const html = adminFooterHtml(null, "owner");
      assert(!html.includes("debug-menu"));
    });

    test("includes the debug menu when debug data is supplied", () => {
      const html = adminFooterHtml(
        {
          cacheStats: [],
          queries: [],
          renderTimeMs: 12,
          uptimeSeconds: 0,
        },
        "owner",
      );
      assertStringIncludes(html, "debug-menu");
      assertStringIncludes(html, "12ms");
    });
  });

  describe("renderAdminFooter", () => {
    test("returns empty string when the page was not flagged as admin", async () => {
      await withRequestContext(async () => {
        expect(renderAdminFooter()).toBe("");
      });
    });

    test("renders the footer with logout once flagged, with no debug menu when query logging is off", async () => {
      await withRequestContext(async () => {
        markAdminFooter("owner");
        const html = renderAdminFooter();
        assertStringIncludes(html, '<footer class="admin-footer">');
        assertStringIncludes(html, '<a href="/admin/logout">Log out</a>');
        // The exact role passed to markAdminFooter drives the gated links: a staff
        // role gets the staff-only log/guide links (proves the stored role is used
        // verbatim, not mangled).
        assertStringIncludes(html, '<a href="/admin/log">Log</a>');
        assertStringIncludes(html, '<a href="/admin/guide">Guide</a>');
        assert(!html.includes("debug-menu"));
      });
    });

    test("renders only logout for a non-staff role flagged via the store", async () => {
      await withRequestContext(async () => {
        markAdminFooter("editor");
        const html = renderAdminFooter();
        assertStringIncludes(html, '<a href="/admin/logout">Log out</a>');
        assert(!html.includes('href="/admin/log"'));
        assert(!html.includes('href="/admin/guide"'));
      });
    });

    test("consumes the flag so a later render is empty", async () => {
      await withRequestContext(async () => {
        markAdminFooter("owner");
        renderAdminFooter();
        expect(renderAdminFooter()).toBe("");
      });
    });

    test("includes the debug menu and uptime when footer debug is enabled", async () => {
      await withRequestContext(async () => {
        enableFooterDebug();
        markAdminFooter("owner");
        const html = renderAdminFooter();
        assertStringIncludes(html, "debug-menu");
        expect(html).toMatch(/up \d+s/);
      });
    });
  });
});
