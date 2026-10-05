import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ensureMessageGroups } from "#i18n";
import { MESSAGE_GROUPS } from "#locales/manifest.ts";
import {
  filterListingsByType,
  groupIdFromRequest,
  intersectListingIds,
  isListingFilter,
  LISTING_FILTERS,
  type ListingFilter,
  listingCategory,
  listingFilterLabel,
  listingTypeFromRequest,
  readChosenId,
  renderGroupFilter,
  renderTypeFilter,
} from "#shared/listing-filter.ts";
import type { ListingType } from "#types";

// The filter labels resolve through the catalog, so it must be loaded first.
await ensureMessageGroups(MESSAGE_GROUPS);

/** A minimal listing shape carrying only the two fields the categoriser reads. */
const listing = (
  purchase_only: boolean,
  listing_type: ListingType,
): { purchase_only: boolean; listing_type: ListingType } => ({
  listing_type,
  purchase_only,
});

const requestForType = (type: string | null): Request =>
  new Request(
    type === null
      ? "http://localhost/admin/listings"
      : `http://localhost/admin/listings?type=${encodeURIComponent(type)}`,
  );

describe("LISTING_FILTERS", () => {
  test("lists all four filter values in canonical order", () => {
    expect(LISTING_FILTERS).toEqual([
      "all",
      "standard",
      "daily",
      "purchase-only",
    ]);
  });
});

describe("listingFilterLabel", () => {
  test("maps each filter value to its exact human label", () => {
    expect(listingFilterLabel("all")).toBe("All");
    expect(listingFilterLabel("standard")).toBe("Standard");
    expect(listingFilterLabel("daily")).toBe("Daily");
    expect(listingFilterLabel("purchase-only")).toBe("No check-in");
  });
});

describe("isListingFilter", () => {
  test("accepts each valid filter value", () => {
    for (const f of LISTING_FILTERS) {
      expect(isListingFilter(f)).toBe(true);
    }
  });

  test("rejects a non-filter string", () => {
    expect(isListingFilter("weekly")).toBe(false);
    expect(isListingFilter("")).toBe(false);
    expect(isListingFilter("ALL")).toBe(false);
  });

  test("rejects null", () => {
    expect(isListingFilter(null)).toBe(false);
  });
});

describe("listingTypeFromRequest", () => {
  test("returns the ?type= value when it is a valid filter", () => {
    expect(listingTypeFromRequest(requestForType("daily"))).toBe("daily");
    expect(listingTypeFromRequest(requestForType("standard"))).toBe("standard");
    expect(listingTypeFromRequest(requestForType("purchase-only"))).toBe(
      "purchase-only",
    );
    expect(listingTypeFromRequest(requestForType("all"))).toBe("all");
  });

  test("defaults to 'all' when ?type= is an unknown value", () => {
    expect(listingTypeFromRequest(requestForType("weekly"))).toBe("all");
  });

  test("defaults to 'all' when ?type= is absent", () => {
    expect(listingTypeFromRequest(requestForType(null))).toBe("all");
  });
});

describe("listingCategory", () => {
  test("is 'purchase-only' whenever purchase_only is set, regardless of type", () => {
    expect(listingCategory(listing(true, "standard"))).toBe("purchase-only");
    expect(listingCategory(listing(true, "daily"))).toBe("purchase-only");
  });

  test("is 'daily' for a non-purchase daily listing", () => {
    expect(listingCategory(listing(false, "daily"))).toBe("daily");
  });

  test("is 'standard' for a non-purchase standard listing", () => {
    expect(listingCategory(listing(false, "standard"))).toBe("standard");
  });
});

describe("filterListingsByType", () => {
  const listings = [
    listing(false, "standard"),
    listing(false, "daily"),
    listing(true, "standard"),
  ];

  test("'all' passes every listing through", () => {
    expect(filterListingsByType("all")(listings)).toEqual(listings);
  });

  test("'all' returns a fresh array, not the input reference", () => {
    const result = filterListingsByType("all")(listings);
    expect(result).not.toBe(listings);
  });

  test("'standard' keeps only non-purchase standard listings", () => {
    expect(filterListingsByType("standard")(listings)).toEqual([
      listing(false, "standard"),
    ]);
  });

  test("'daily' keeps only non-purchase daily listings", () => {
    expect(filterListingsByType("daily")(listings)).toEqual([
      listing(false, "daily"),
    ]);
  });

  test("'purchase-only' keeps only purchase-only listings", () => {
    expect(filterListingsByType("purchase-only")(listings)).toEqual([
      listing(true, "standard"),
    ]);
  });
});

describe("renderTypeFilter", () => {
  const href = (f: ListingFilter): string => `/admin/listings?type=${f}`;

  test("renders 'all' plus only the present categories, in canonical order", () => {
    const html = renderTypeFilter("all", ["daily", "standard"], href);
    expect(html).toBe(
      '<div class="table-actions">Showing: ' +
        "<strong><u>All</u></strong>" +
        ' / <a href="/admin/listings?type=standard">Standard</a>' +
        ' / <a href="/admin/listings?type=daily">Daily</a>' +
        "</div>",
    );
  });

  test("bolds the active option and links the rest via hrefFor", () => {
    const html = renderTypeFilter("daily", ["standard", "daily"], href);
    expect(html).toBe(
      '<div class="table-actions">Showing: ' +
        '<a href="/admin/listings?type=all">All</a>' +
        ' / <a href="/admin/listings?type=standard">Standard</a>' +
        " / <strong><u>Daily</u></strong>" +
        "</div>",
    );
  });

  test("omits categories that are not present", () => {
    const html = renderTypeFilter("all", ["standard"], href);
    expect(html).toBe(
      '<div class="table-actions">Showing: ' +
        "<strong><u>All</u></strong>" +
        ' / <a href="/admin/listings?type=standard">Standard</a>' +
        "</div>",
    );
    expect(html).not.toContain("?type=daily");
    expect(html).not.toContain("No check-in");
  });

  test("does not duplicate 'All' when 'all' is itself passed in categories", () => {
    const html = renderTypeFilter("standard", ["all", "standard"], href);
    expect(html).toBe(
      '<div class="table-actions">Showing: ' +
        '<a href="/admin/listings?type=all">All</a>' +
        " / <strong><u>Standard</u></strong>" +
        "</div>",
    );
    // The leading "all" option must appear exactly once, never echoed by the
    // categories list — this is what the `f !== "all"` guard protects.
    expect(html.match(/type=all/g)).toHaveLength(1);
  });

  test("offers only 'All' when no categories are present", () => {
    const html = renderTypeFilter("all", [], href);
    expect(html).toBe(
      '<div class="table-actions">Showing: <strong><u>All</u></strong></div>',
    );
  });

  test("renders all four options with 'purchase-only' labelled 'No check-in'", () => {
    const html = renderTypeFilter(
      "purchase-only",
      ["standard", "daily", "purchase-only"],
      href,
    );
    expect(html).toBe(
      '<div class="table-actions">Showing: ' +
        '<a href="/admin/listings?type=all">All</a>' +
        ' / <a href="/admin/listings?type=standard">Standard</a>' +
        ' / <a href="/admin/listings?type=daily">Daily</a>' +
        " / <strong><u>No check-in</u></strong>" +
        "</div>",
    );
  });
});

const GROUPS = [
  { id: 2, name: "Weekend" },
  { id: 1, name: "Autumn fair" },
];

const requestForGroup = (group: string | null): Request =>
  new Request(
    group === null
      ? "http://localhost/admin/listings"
      : `http://localhost/admin/listings?group=${encodeURIComponent(group)}`,
  );

describe("readChosenId", () => {
  test("keeps an id the page offers", () => {
    expect(readChosenId(GROUPS, "2")).toBe(2);
  });

  test("falls back to all groups for an unknown id", () => {
    expect(readChosenId(GROUPS, "999999")).toBe(null);
  });

  test("falls back to all groups for a malformed id", () => {
    expect(readChosenId(GROUPS, "2x")).toBe(null);
    expect(readChosenId(GROUPS, "-1")).toBe(null);
  });

  test("falls back to all groups when no address value is present", () => {
    expect(readChosenId(GROUPS, null)).toBe(null);
  });

  test("offers nothing when the site stores no groups", () => {
    expect(readChosenId([], "2")).toBe(null);
  });
});

describe("groupIdFromRequest", () => {
  test("reads the ?group= filter the pages share", () => {
    expect(groupIdFromRequest(requestForGroup("1"), GROUPS)).toBe(1);
  });

  test("answers all groups when the address names none", () => {
    expect(groupIdFromRequest(requestForGroup(null), GROUPS)).toBe(null);
  });

  test("answers all groups for a deleted group id", () => {
    expect(groupIdFromRequest(requestForGroup("7"), GROUPS)).toBe(null);
  });
});

describe("intersectListingIds", () => {
  const members = new Set([1, 2]);

  test("stays open when neither side restricts", () => {
    expect(intersectListingIds(null, null)).toBe(null);
  });

  test("keeps the member ids when only the group restricts", () => {
    expect(intersectListingIds(null, members)).toEqual([1, 2]);
  });

  test("keeps the chosen listings when only they restrict", () => {
    expect(intersectListingIds([3], null)).toEqual([3]);
  });

  test("keeps only the chosen listings inside the group", () => {
    expect(intersectListingIds([2, 3], members)).toEqual([2]);
  });

  test("keeps nothing when the chosen listings sit outside the group", () => {
    expect(intersectListingIds([3], new Set())).toEqual([]);
  });
});

describe("renderGroupFilter", () => {
  const href = (groupId: number | null): string =>
    groupId === null ? "/admin/listings" : `/admin/listings?group=${groupId}`;

  test("renders All groups plus one entry per stored group, by name", () => {
    const html = renderGroupFilter(null, GROUPS, href);
    expect(html).toBe(
      '<div class="table-actions">Group: ' +
        "<strong><u>All groups</u></strong>" +
        ' / <a href="/admin/listings?group=1">Autumn fair</a>' +
        ' / <a href="/admin/listings?group=2">Weekend</a>' +
        "</div>",
    );
  });

  test("bolds the active group and links the rest", () => {
    const html = renderGroupFilter(2, GROUPS, href);
    expect(html).toBe(
      '<div class="table-actions">Group: ' +
        '<a href="/admin/listings">All groups</a>' +
        ' / <a href="/admin/listings?group=1">Autumn fair</a>' +
        " / <strong><u>Weekend</u></strong>" +
        "</div>",
    );
  });

  test("renders nothing when the site stores no groups", () => {
    expect(renderGroupFilter(null, [], href)).toBe("");
  });
});
