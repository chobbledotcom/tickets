import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  attributeFilterHref,
  emptyAttributeFilterView,
  renderAttributeFilterBars,
  typeFilterHref,
} from "#templates/admin/listing-attribute-filters.ts";

describe("listing attribute filter template helpers", () => {
  test("creates an empty filter view", () => {
    const view = emptyAttributeFilterView();

    expect(view.activeAttributeFilters.size).toBe(0);
    expect(view.attributeFilters).toEqual([]);
    expect(view.attributesByListing.size).toBe(0);
  });

  test("keeps active attribute filters in type filter links", () => {
    const href = typeFilterHref("/admin/", new Map([[1, 11]]));

    expect(href("daily")).toBe("/admin/?type=daily&attribute_1=11");
    expect(href("all")).toBe("/admin/?attribute_1=11");
  });

  test("adds and removes one attribute filter while keeping the type filter", () => {
    const href = attributeFilterHref("/admin/", "daily", new Map([[1, 11]]));

    expect(href(2, 21)).toBe(
      "/admin/?type=daily&attribute_1=11&attribute_2=21",
    );
    expect(href(1, null)).toBe("/admin/?type=daily");
  });

  test("renders escaped filter bars with active options", () => {
    const html = renderAttributeFilterBars(
      [
        {
          id: 1,
          name: "A & B",
          options: [
            { id: 11, sort_order: 1, text: "Easy <Hard>" },
            { id: 12, sort_order: 2, text: "Hard" },
          ],
          sort_order: 1,
        },
      ],
      new Map([[1, 12]]),
      (attributeId, optionId) =>
        optionId === null
          ? `/admin/?clear=${attributeId}`
          : `/admin/?attribute_${attributeId}=${optionId}`,
    );

    expect(html).toContain("A &amp; B:");
    expect(html).toContain(
      'href="/admin/?attribute_1=11">Easy &lt;Hard&gt;</a>',
    );
    expect(html).toContain("<strong><u>Hard</u></strong>");
    expect(html).toContain('href="/admin/?clear=1">All</a>');
  });
});
