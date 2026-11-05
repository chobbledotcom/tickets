import { assert, assertStringIncludes } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import type { LedgerFilterState } from "#templates/admin/ledger/filter.tsx";
import {
  adminLedgerPage,
  type LedgerPageData,
} from "#templates/admin/ledger.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { featureSetting, useSetting } from "#test-utils/settings.ts";
import { names, transfer } from "./helpers.ts";

describe("adminLedgerPage", () => {
  beforeAll(setupAdminPageTest);
  useSetting(featureSetting("money"));

  const NO_FILTERS: LedgerFilterState = {
    from: null,
    fromMonth: null,
    scope: { kind: "all" },
    to: null,
    toMonth: null,
    view: "human",
  };

  const pageData = (
    overrides: Partial<LedgerPageData> = {},
  ): LedgerPageData => ({
    dates: [
      { label: "Sat 20 June 2026", selectable: true, value: "2026-06-20" },
    ],
    filters: NO_FILTERS,
    groups: [{ id: 2, name: "Festival package" }],
    listings: [{ id: 1, name: "Summer Concert" }],
    names: names(),
    returnUrl: "/admin/ledger",
    stats: [{ key: "Total income", value: "£25.00" }],
    statsHeading: null,
    today: "2026-06-23",
    transfers: [transfer()],
    truncated: false,
    ...overrides,
  });

  test("renders the money heading, nav, stats, filters, and simple list", () => {
    const html = adminLedgerPage(pageData(), OWNER_SESSION);
    assertStringIncludes(html, "Money");
    assert(!html.includes("Money history"));
    expectIncludesAll(html, [
      'href="/admin/ledger"',
      "<th>Activity</th>",
      "Simple view",
      "Detailed view",
      "Money moved from",
      // The whole-business scope is selected and keeps an unscoped URL.
      '<option selected value="/admin/ledger">Everything</option>',
      "Total income",
      "£25.00",
      // Both range pickers render with unique anchor ids.
      'id="ledger-from"',
      'id="ledger-to"',
      // The by-listing select lists every listing plus the "all" option.
      "Everything",
      "Summer Concert",
      '<option selected value="/admin/ledger">Everything</option>',
      "Festival package",
    ]);
  });

  test("heads the stats with the listing name when scoped to one listing", () => {
    const html = adminLedgerPage(
      pageData({ statsHeading: "Summer Concert" }),
      OWNER_SESSION,
    );
    assertStringIncludes(html, "<h2>Summer Concert</h2>");
  });

  test("can switch to the detailed money-change list", () => {
    const html = adminLedgerPage(
      pageData({ filters: { ...NO_FILTERS, view: "dual" } }),
      OWNER_SESSION,
    );
    expectIncludesAll(html, [
      "<th>Money moved</th>",
      'href="/admin/ledger">Simple view</a>',
      "<strong>Detailed view</strong>",
    ]);
  });

  test("preselects the chosen listing in the by-listing select", () => {
    const html = adminLedgerPage(
      pageData({
        filters: {
          ...NO_FILTERS,
          scope: { id: 1, kind: "listing", name: "Summer Concert" },
        },
      }),
      OWNER_SESSION,
    );
    // The listing option carries `selected`; its value scopes the URL to it.
    assertStringIncludes(
      html,
      '<option selected value="/admin/ledger?listing=1">Summer Concert</option>',
    );
  });

  test("preselects a group and keeps its ledger scope in links", () => {
    const html = adminLedgerPage(
      pageData({
        filters: {
          ...NO_FILTERS,
          scope: { id: 2, kind: "group", name: "Festival package" },
        },
        statsHeading: "Festival package",
      }),
      OWNER_SESSION,
    );
    expectIncludesAll(html, [
      '<option selected value="/admin/ledger?group=2">Festival package</option>',
      "<h2>Festival package</h2>",
    ]);
  });

  test("day links carry the from/to filters and the other side's state", () => {
    const html = adminLedgerPage(
      pageData({
        filters: {
          ...NO_FILTERS,
          from: "2026-06-20",
          scope: { id: 1, kind: "listing", name: "Summer Concert" },
        },
      }),
      OWNER_SESSION,
    );
    // A "to" day link keeps the existing from + listing scope.
    expectIncludesAll(html, ["to=2026-06-20", "from=2026-06-20", "listing=1"]);
  });

  test("filter links preserve dual view and paged calendar state", () => {
    const html = adminLedgerPage(
      pageData({
        filters: {
          ...NO_FILTERS,
          from: "2026-06-20",
          fromMonth: "2026-05",
          scope: { id: 1, kind: "listing", name: "Summer Concert" },
          to: "2026-06-22",
          toMonth: "2026-07",
          view: "dual",
        },
      }),
      OWNER_SESSION,
    );
    expectIncludesAll(html, [
      'value="/admin/ledger?from=2026-06-20&amp;to=2026-06-22&amp;view=dual&amp;fromCal=2026-05&amp;toCal=2026-07"',
      "view=dual",
      "toCal=2026-07",
    ]);
  });

  test("surfaces the 'showing recent' note only when truncated", () => {
    const shown = adminLedgerPage(pageData({ truncated: true }), OWNER_SESSION);
    assertStringIncludes(shown, "Showing the 500 most recent money changes.");
    const all = adminLedgerPage(pageData({ truncated: false }), OWNER_SESSION);
    assert(!all.includes("Showing the 500 most recent money changes."));
  });
});
