import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { defineTableLayout } from "#shared/tables/layout.ts";

const KEYS = ["name", "created"] as const;
const layoutDefinition = defineTableLayout({ options: KEYS }, KEYS);

describe("table layouts", () => {
  test("builds the default template in key order", () => {
    expect(layoutDefinition.defaultTemplate).toBe("{{name}}, {{created}}");
  });

  test("uses the default layout for an empty template", () => {
    expect(layoutDefinition.parse("")).toBe(layoutDefinition.defaultLayout);
    expect(layoutDefinition.validate("")).toBe(null);
  });

  test("parses columns, filters, and first-occurrence order", () => {
    const layout = layoutDefinition.parse(
      '{{created | date: "%B"}}, {{name}}, {{created}}',
    );

    expect(layout.columnKeys).toEqual(["created", "name"]);
    expect([...layout.filters]).toEqual([["created", 'created | date: "%B"']]);
  });

  test("rejects an unknown column and keeps the first error", () => {
    expect(layoutDefinition.validate("{{missing}}, {{other}}")).toBe(
      'Unknown column "missing". Available columns: name, created',
    );
    expect(() => layoutDefinition.parse("{{missing}}")).toThrow(
      'Unknown column "missing"',
    );
  });

  test("rejects a template without a column tag", () => {
    expect(layoutDefinition.validate("name, created")).toBe(
      "Template must include at least one column",
    );
    expect(() => layoutDefinition.parse("name, created")).toThrow(
      "Template must include at least one column",
    );
  });

  test("rejects a default column that is not configurable", () => {
    expect(() => defineTableLayout({ options: ["name"] }, ["missing"])).toThrow(
      'defineTableLayout: default key "missing" is not configurable',
    );
  });

  test("rejects duplicate configurable keys", () => {
    expect(() =>
      defineTableLayout({ options: ["name", "name"] }, ["name"]),
    ).toThrow("defineTableLayout: column keys must be unique");
  });
});
