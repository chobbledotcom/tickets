import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { LedgerFilterState } from "#templates/admin/ledger/filter.tsx";
import {
  adminLedgerPage,
  type LedgerPageData,
} from "#templates/admin/ledger.tsx";

import { names, SESSION, transfer } from "./helpers.ts";

describe("adminLedgerPage", () => {
  const NO_FILTERS: LedgerFilterState = {
    from: null,
    fromMonth: null,
    groupId: null,
    listingId: null,
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

  test("renders the Ledger heading, nav, stats, filters, and the plain-language transfer list", () => {
    const html = adminLedgerPage(pageData(), SESSION);
    expect(html).toContain("Ledger");
    expect(html).toContain('href="/admin/ledger"');
    expect(html).toContain("<th>Activity</th>");
    expect(html).toContain("Plain-language log");
    expect(html).toContain("Double-entry view");
    expect(html).toContain("Transfer from");
    // The stats table renders; the whole-business view carries no scope heading
    // (the page is already titled "Ledger").
    expect(html).not.toContain("<h2>All listings</h2>");
    expect(html).toContain("Total income");
    expect(html).toContain("£25.00");
    // Both range pickers render with unique anchor ids.
    expect(html).toContain('id="ledger-from"');
    expect(html).toContain('id="ledger-to"');
    // The by-listing select lists every listing plus the "all" option.
    expect(html).toContain("Everything");
    expect(html).toContain("Summer Concert");
    expect(html).toContain(
      '<option selected value="/admin/ledger">Everything</option>',
    );
    expect(html).toContain("Festival package");
  });

  test("heads the stats with the listing name when scoped to one listing", () => {
    const html = adminLedgerPage(
      pageData({ statsHeading: "Summer Concert" }),
      SESSION,
    );
    expect(html).toContain("<h2>Summer Concert</h2>");
  });

  test("can switch to the double-entry transfer list", () => {
    const html = adminLedgerPage(
      pageData({ filters: { ...NO_FILTERS, view: "dual" } }),
      SESSION,
    );
    expect(html).toContain("<th>From → To</th>");
    expect(html).toContain('href="/admin/ledger">Plain-language log</a>');
    expect(html).toContain("<strong>Double-entry view</strong>");
  });

  test("preselects the chosen listing in the by-listing select", () => {
    const html = adminLedgerPage(
      pageData({ filters: { ...NO_FILTERS, listingId: 1 } }),
      SESSION,
    );
    // The listing option carries `selected`; its value scopes the URL to it.
    expect(html).toContain(
      '<option selected value="/admin/ledger?listing=1">Summer Concert</option>',
    );
  });

  test("preselects a group and keeps its ledger scope in links", () => {
    const html = adminLedgerPage(
      pageData({
        filters: { ...NO_FILTERS, groupId: 2 },
        statsHeading: "Festival package",
      }),
      SESSION,
    );
    expect(html).toContain(
      '<option selected value="/admin/ledger?group=2">Festival package</option>',
    );
    expect(html).toContain("<h2>Festival package</h2>");
  });

  test("day links carry the from/to filters and the other side's state", () => {
    const html = adminLedgerPage(
      pageData({
        filters: { ...NO_FILTERS, from: "2026-06-20", listingId: 1 },
      }),
      SESSION,
    );
    // A "to" day link keeps the existing from + listing scope.
    expect(html).toContain("to=2026-06-20");
    expect(html).toContain("from=2026-06-20");
    expect(html).toContain("listing=1");
  });

  test("filter links preserve dual view and paged calendar state", () => {
    const html = adminLedgerPage(
      pageData({
        filters: {
          ...NO_FILTERS,
          from: "2026-06-20",
          fromMonth: "2026-05",
          listingId: 1,
          to: "2026-06-22",
          toMonth: "2026-07",
          view: "dual",
        },
      }),
      SESSION,
    );
    expect(html).toContain(
      'value="/admin/ledger?from=2026-06-20&amp;to=2026-06-22&amp;view=dual&amp;fromCal=2026-05&amp;toCal=2026-07"',
    );
    expect(html).toContain("view=dual");
    expect(html).toContain("toCal=2026-07");
  });

  test("surfaces the 'showing recent' note only when truncated", () => {
    const shown = adminLedgerPage(pageData({ truncated: true }), SESSION);
    expect(shown).toContain("Showing the most recent 500 transfers");
    const all = adminLedgerPage(pageData({ truncated: false }), SESSION);
    expect(all).not.toContain("Showing the most recent 500 transfers");
  });
});
