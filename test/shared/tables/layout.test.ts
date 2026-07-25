import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  buildDefaultTemplate,
  defineTableLayout,
  parseLayout,
  type TableLayout,
  validateLayout,
} from "#shared/tables/layout.ts";

const KEYS = ["name", "created"] as const;
const DEFAULT_LAYOUT: TableLayout<(typeof KEYS)[number]> = {
  columnKeys: KEYS,
  filters: new Map(),
};

describe("table layouts", () => {
  test("builds the default template in key order", () => {
    expect(buildDefaultTemplate(KEYS)).toBe("{{name}}, {{created}}");
  });

  test("uses the default layout for an empty template", () => {
    expect(parseLayout("", KEYS, DEFAULT_LAYOUT)).toBe(DEFAULT_LAYOUT);
    expect(validateLayout("", KEYS)).toBe(null);
  });

  test("parses columns, filters, and first-occurrence order", () => {
    const layout = parseLayout(
      '{{created | date: "%B"}}, {{name}}, {{created}}',
      KEYS,
      DEFAULT_LAYOUT,
    );

    expect(layout.columnKeys).toEqual(["created", "name"]);
    expect([...layout.filters]).toEqual([["created", 'created | date: "%B"']]);
  });

  test("rejects an unknown column and keeps the first error", () => {
    expect(validateLayout("{{missing}}, {{other}}", KEYS)).toBe(
      'Unknown column "missing". Available columns: name, created',
    );
    expect(() => parseLayout("{{missing}}", KEYS, DEFAULT_LAYOUT)).toThrow(
      'Unknown column "missing"',
    );
  });

  test("rejects a template without a column tag", () => {
    expect(validateLayout("name, created", KEYS)).toBe(
      "Template must include at least one column",
    );
    expect(() => parseLayout("name, created", KEYS, DEFAULT_LAYOUT)).toThrow(
      "Template must include at least one column",
    );
  });

  test("rejects a default column that is not configurable", () => {
    expect(() => defineTableLayout({ options: ["name"] }, ["missing"])).toThrow(
      'defineTableLayout: default key "missing" is not configurable',
    );
  });
});
