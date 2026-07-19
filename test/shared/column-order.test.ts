import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { COLUMN_LAYOUTS } from "#shared/column-layout.ts";
import type { ColumnDef, ColumnGenerators } from "#shared/column-order.ts";
import {
  getHeaderText,
  renderCells,
  renderFilteredValue,
} from "#shared/column-order.ts";
import { LISTING_TABLE_COLUMNS } from "#shared/columns/listing-columns.ts";
import { escapeHtml } from "#templates/layout.tsx";
import { setupTestEncryptionKey } from "#test-utils/env.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

setupTestEncryptionKey();

describe("renderFilteredValue", () => {
  test("applies date filter with strftime format", () => {
    const result = renderFilteredValue(
      'created | date: "%B %d, %Y"',
      "2026-04-10T19:00:00Z",
      "created",
    );
    expect(result).toContain("April");
    expect(result).toContain("2026");
  });

  test("applies date filter with short format", () => {
    const result = renderFilteredValue(
      'date | date: "%d/%m/%Y"',
      "2026-03-15",
      "date",
    );
    expect(result).toBe("15/03/2026");
  });

  test("applies currency filter", () => {
    const result = renderFilteredValue("price | currency", 2500, "price");
    expect(result).toContain("25");
  });

  test("returns empty string for falsy date value", () => {
    expect(renderFilteredValue('date | date: "%B"', "", "date")).toBe("");
  });

  test("passes through unparseable date string", () => {
    expect(renderFilteredValue('date | date: "%B"', "not-a-date", "date")).toBe(
      "not-a-date",
    );
  });

  test("renders value without filter when no pipe", () => {
    expect(renderFilteredValue("name", "Alice", "name")).toBe("Alice");
  });

  test("does not attempt Date conversion for a non-string raw value", () => {
    // A null rawValue is falsy-but-non-null, so it must skip conversion and
    // render as empty — converting null via `new Date(null)` would render
    // the 1970 epoch date instead.
    expect(renderFilteredValue('date | date: "%B"', null, "date")).toBe("");
  });

  test("only converts to a Date when the filter expression is a date filter", () => {
    // "2026-01-01" is Date-parseable, but the filter here is `upcase`, not a
    // date filter, so the raw string must pass through unconverted.
    expect(renderFilteredValue("date | upcase", "2026-01-01", "date")).toBe(
      "2026-01-01",
    );
  });

  test("does not convert to a Date when a filter runs before the date filter", () => {
    // Regression: converting whenever the expression merely *contains*
    // "| date" (rather than checking `date` is the first filter) fed a Date
    // object into `append`, breaking the pipeline — the appended string
    // "T00:00:00Z" landed on the Date's toString() instead of the raw string.
    expect(
      renderFilteredValue(
        'created | append: "T00:00:00Z" | date: "%Y"',
        "2026-04-10",
        "created",
      ),
    ).toBe("2026");
  });
});

describe("renderCells", () => {
  test("rejects a column missing from the supplied definitions", () => {
    expect(() =>
      renderCells({}, ["missing"], {}, undefined, new Map(), escapeHtml),
    ).toThrow("Unknown column: missing");
  });

  test("renders listing columns end-to-end through the full pipeline", () => {
    const listing = testListingWithCount({
      date: "2026-06-15",
      name: "Jazz Night",
      unit_price: 0,
    });
    const { columnKeys, filters } = COLUMN_LAYOUTS.listing.parse(
      "{{name}}, {{price}}, {{date}}",
    );
    const html = renderCells(
      listing,
      columnKeys,
      LISTING_TABLE_COLUMNS,
      undefined as unknown,
      filters,
      escapeHtml,
    );
    expect(html).toContain("Jazz Night");
    expect(html).toContain("Free");
    expect(html).toContain("<td>");
  });

  test("applies Liquid filters when template uses them", () => {
    const listing = testListingWithCount({
      created: "2026-01-10T09:00:00Z",
      date: "2026-03-15",
      unit_price: 2500,
    });
    const { columnKeys, filters } = COLUMN_LAYOUTS.listing.parse(
      '{{date | date: "%d/%m/%Y"}}, {{created | date: "%B %Y"}}, {{price | currency}}',
    );
    const html = renderCells(
      listing,
      columnKeys,
      LISTING_TABLE_COLUMNS,
      undefined as unknown,
      filters,
      escapeHtml,
    );
    expect(html).toContain("15/03/2026");
    expect(html).toContain("January 2026");
    expect(html).toContain("25");
  });

  test("escapes HTML in plain text cells to prevent XSS", () => {
    const listing = testListingWithCount({
      location: '<script>alert("xss")</script>',
    });
    const { columnKeys, filters } =
      COLUMN_LAYOUTS.listing.parse("{{location}}");
    const html = renderCells(
      listing,
      columnKeys,
      LISTING_TABLE_COLUMNS,
      undefined as unknown,
      filters,
      escapeHtml,
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("joins rendered cells with no separator", () => {
    const generators: ColumnGenerators<{ a: string; b: string }> = {
      colA: { cell: (r) => r.a, description: "test", label: "A" },
      colB: { cell: (r) => r.b, description: "test", label: "B" },
    };
    const html = renderCells(
      { a: "1", b: "2" },
      ["colA", "colB"],
      generators,
      undefined,
      new Map(),
      escapeHtml,
    );
    expect(html).toBe("<td>1</td><td>2</td>");
  });

  test("escapes filtered output even when the column is marked isHtml", () => {
    // Filtered values are always plain text (per renderCells' contract), so
    // a filter must still be escaped even on an isHtml column.
    const generators: ColumnGenerators<{ raw: string }> = {
      val: {
        cell: (r) => r.raw,
        description: "test",
        isHtml: true,
        label: "Val",
        rawValue: (r) => r.raw,
      },
    };
    const html = renderCells(
      { raw: "<b>bold</b>" },
      ["val"],
      generators,
      undefined,
      new Map([["val", "val | upcase"]]),
      escapeHtml,
    );
    expect(html).toBe("<td>&lt;B&gt;BOLD&lt;/B&gt;</td>");
  });

  test("does not escape isHtml column content when no filter is applied", () => {
    const generators: ColumnGenerators<{ raw: string }> = {
      val: {
        cell: (r) => r.raw,
        description: "test",
        isHtml: true,
        label: "Val",
      },
    };
    const html = renderCells(
      { raw: "<b>bold</b>" },
      ["val"],
      generators,
      undefined,
      new Map(),
      escapeHtml,
    );
    expect(html).toBe("<td><b>bold</b></td>");
  });

  test("applies CSS class from column definition", () => {
    const generators: ColumnGenerators<{ val: string }> = {
      val: {
        cell: (r) => r.val,
        className: "custom-class",
        description: "test",
        label: "Val",
      },
    };
    const html = renderCells(
      { val: "hi" },
      ["val"],
      generators,
      undefined,
      new Map(),
      escapeHtml,
    );
    expect(html).toContain('class="custom-class"');
  });
});

describe("getHeaderText", () => {
  test("returns headerText when set", () => {
    expect(getHeaderText(LISTING_TABLE_COLUMNS.name!)).toBe("Listing Name");
  });

  test("falls back to label when headerText is not set", () => {
    expect(getHeaderText(LISTING_TABLE_COLUMNS.location!)).toBe("Location");
  });

  test("keeps an explicit empty-string headerText instead of falling back to label", () => {
    const col: ColumnDef<unknown> = {
      cell: () => "",
      description: "test",
      headerText: "",
      label: "Fallback Label",
    };
    expect(getHeaderText(col)).toBe("");
  });
});
