import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { buildDefaultTemplate, COLUMN_LAYOUTS } from "#shared/column-layout.ts";
import {
  EDITOR_LISTING_LAYOUT,
  EDITOR_LISTING_TABLE_COLUMNS,
  LISTING_TABLE_COLUMNS,
} from "#shared/columns/listing-columns.ts";

describe("column layout validation", () => {
  test("derives every listing schema from the matching column definitions", () => {
    expect([...COLUMN_LAYOUTS.listing.schema.options].sort()).toEqual(
      Object.keys(LISTING_TABLE_COLUMNS).sort(),
    );
    expect([...EDITOR_LISTING_LAYOUT.columnKeys].sort()).toEqual(
      Object.keys(EDITOR_LISTING_TABLE_COLUMNS).sort(),
    );
  });

  test("returns null for valid template", () => {
    expect(COLUMN_LAYOUTS.listing.validate("{{name}}, {{status}}")).toBeNull();
  });

  test("handles wonky spacing", () => {
    expect(
      COLUMN_LAYOUTS.listing.validate(
        "{{ name }},{{description}},  {{ status  }}",
      ),
    ).toBeNull();
  });

  test("rejects unknown column", () => {
    const error = COLUMN_LAYOUTS.listing.validate("{{name}}, {{descritpion}}");
    expect(error).toContain("descritpion");
    expect(error).toContain("Available columns");
  });

  test("lists the schema columns in the error message", () => {
    expect(COLUMN_LAYOUTS.attendee.validate("{{bogus}}")).toBe(
      `Unknown column "bogus". Available columns: ${COLUMN_LAYOUTS.attendee.schema.options.join(", ")}`,
    );
  });

  test("accepts an empty template as the default layout", () => {
    expect(COLUMN_LAYOUTS.listing.validate("")).toBeNull();
  });

  test("rejects a non-empty template with no column tags", () => {
    expect(COLUMN_LAYOUTS.listing.validate("name, status")).toBe(
      "Template must include at least one column",
    );
  });

  test("accepts supported filters", () => {
    expect(
      COLUMN_LAYOUTS.listing.validate(
        '{{name}}, {{created | date: "%B"}}, {{price | currency}}',
      ),
    ).toBeNull();
  });
});

test("keeps the attendee default column order", () => {
  expect(COLUMN_LAYOUTS.attendee.defaultOrder).toEqual([
    "status",
    "date",
    "name",
    "listings",
    "email",
    "phone",
    "address",
    "special_instructions",
    "answers",
    "qty",
    "ticket",
    "registered",
  ]);
});

describe("column layout parsing", () => {
  test("returns default order when template is empty", () => {
    const { columnKeys, filters } = COLUMN_LAYOUTS.listing.parse("");
    expect(columnKeys).toEqual(COLUMN_LAYOUTS.listing.defaultOrder);
    expect(filters.size).toBe(0);
  });

  test("returns unique columns in template order", () => {
    const { columnKeys } = COLUMN_LAYOUTS.listing.parse(
      "{{status}}, {{name}}, {{status}}",
    );
    expect(columnKeys).toEqual(["status", "name"]);
  });

  test("throws for an invalid template", () => {
    expect(() => COLUMN_LAYOUTS.listing.parse("{{bogus}}")).toThrow(
      'Unknown column "bogus"',
    );
  });

  test("extracts only supplied filter expressions", () => {
    const { filters } = COLUMN_LAYOUTS.listing.parse(
      '{{name}}, {{created | date: "%B %d"}}',
    );
    expect(filters.get("created")).toBe('created | date: "%B %d"');
    expect(filters.has("name")).toBe(false);
  });

  test("resolves all attendee columns from the default template", () => {
    const template = buildDefaultTemplate(COLUMN_LAYOUTS.attendee.defaultOrder);
    expect(COLUMN_LAYOUTS.attendee.parse(template).columnKeys).toEqual(
      COLUMN_LAYOUTS.attendee.defaultOrder,
    );
  });
});

test("buildDefaultTemplate joins column tags", () => {
  expect(buildDefaultTemplate(["a", "b", "c"])).toBe("{{a}}, {{b}}, {{c}}");
});
