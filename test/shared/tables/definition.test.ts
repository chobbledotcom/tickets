import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  columnOrThrow,
  defineTable,
  type TableColumn,
} from "#shared/tables/definition.ts";

type Row = { name: string; status: string };

const columns: TableColumn<Row>[] = [
  { cell: (row) => row.name, header: "Name", key: "name" },
  { cell: (row) => row.status, header: "Status", key: "status" },
];

describe("defineTable", () => {
  test("builds defaults from the declared columns", () => {
    const table = defineTable(columns);

    expect(table.defaultColumnKeys).toEqual(["name", "status"]);
    expect(table.keys).toEqual(["name", "status"]);
    expect(table.defaultTemplate).toBe("{{name}}, {{status}}");
    expect(table.parse("")).toBe(table.defaultLayout);
  });

  test("binds layout parsing and validation to the configured columns", () => {
    const table = defineTable(columns, {
      configKeys: ["name", "status"],
      defaultColumnKeys: ["name"],
    });

    expect(table.parse("{{status}}").columnKeys).toEqual(["status"]);
    expect(table.validate("{{status}}")).toBe(null);
    expect(table.validate("{{missing}}")).toContain('Unknown column "missing"');
  });

  test("rejects an empty column list", () => {
    expect(() => defineTable<Row>([])).toThrow(
      "defineTable: columns cannot be empty",
    );
  });

  test("rejects duplicate column keys", () => {
    expect(() =>
      defineTable<Row>([
        { cell: (row) => row.name, header: "First", key: "name" },
        { cell: (row) => row.name, header: "Second", key: "name" },
      ]),
    ).toThrow('defineTable: duplicate column key "name"');
  });

  test("rejects a configurable key without a column", () => {
    expect(() => defineTable(columns, { configKeys: ["missing"] })).toThrow(
      'defineTable: config key "missing" is not a column (have name, status)',
    );
  });

  test("rejects a default key without a column", () => {
    expect(() =>
      defineTable(columns, {
        configKeys: ["name"],
        defaultColumnKeys: ["missing"],
      }),
    ).toThrow(
      'defineTable: default key "missing" is not a column (have name, status)',
    );
  });
});

describe("columnOrThrow", () => {
  test("returns the declared column", () => {
    expect(columnOrThrow(defineTable(columns), "status")).toBe(columns[1]);
  });

  test("rejects an unknown column", () => {
    expect(() => columnOrThrow(defineTable(columns), "missing")).toThrow(
      'Column "missing" is not in the table\'s set (have name, status)',
    );
  });
});
