import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import type { TableColumn } from "#shared/tables/column.ts";
import {
  attachTableRenderers,
  columnOrThrow,
  defineTable,
} from "#shared/tables/definition.ts";
import { defineTableLayout } from "#shared/tables/layout.ts";

type Row = { name: string; status: string };

const columns: TableColumn<Row>[] = [
  { cell: (row) => row.name, header: "Name", key: "name" },
  { cell: (row) => row.status, header: "Status", key: "status" },
];

describe("defineTable", () => {
  test("builds a fixed layout from the declared columns", () => {
    const table = defineTable(columns);

    expect(table.layout.defaultColumnKeys).toEqual(["name", "status"]);
    expect(table.layout.keys).toEqual(["name", "status"]);
    expect(table.layout.defaultTemplate).toBe("{{name}}, {{status}}");
    expect(table.layout.parse("")).toBe(table.layout.defaultLayout);
  });

  test("attaches every renderer to a configurable layout", () => {
    const layout = defineTableLayout(v.picklist(["name", "status"]), ["name"]);
    const table = attachTableRenderers<Row, undefined, "name" | "status">(
      layout,
      {
        name: { cell: (row) => row.name, header: "Name" },
        status: { cell: (row) => row.status, header: "Status" },
      },
    );

    expect(table.columns.map((column) => column.key)).toEqual([
      "name",
      "status",
    ]);
    expect(table.layout.defaultColumnKeys).toEqual(["name"]);
    expect(table.layout.parse("{{status}}").columnKeys).toEqual(["status"]);
    expect(table.layout.validate("{{status}}")).toBe(null);
    expect(table.layout.validate("{{missing}}")).toContain(
      'Unknown column "missing"',
    );
  });

  test("rejects an empty column list", () => {
    expect(() => defineTable<Row>([])).toThrow(
      "defineTable: columns cannot be empty",
    );
  });

  test("rejects duplicate fixed-table keys", () => {
    expect(() =>
      defineTable<Row>([
        { cell: (row) => row.name, header: "First", key: "name" },
        { cell: (row) => row.name, header: "Second", key: "name" },
      ]),
    ).toThrow("defineTableLayout: column keys must be unique");
  });

  test("rejects a layout renderer that is missing", () => {
    const layout = defineTableLayout(v.picklist(["name", "status"]), [
      "name",
      "status",
    ]);
    const renderers = {
      name: { cell: (row: Row) => row.name, header: "Name" },
      status: { cell: (row: Row) => row.status, header: "Status" },
    };
    Reflect.deleteProperty(renderers, "status");

    expect(() => attachTableRenderers(layout, renderers)).toThrow(
      'attachTableRenderers: key "status" has no renderer',
    );
  });

  test("rejects a renderer outside the layout", () => {
    const layout = defineTableLayout(v.picklist(["name"]), ["name"]);
    const renderers = Object.assign(
      { name: { cell: (row: Row) => row.name, header: "Name" } },
      { status: { cell: (row: Row) => row.status, header: "Status" } },
    );

    expect(() => attachTableRenderers(layout, renderers)).toThrow(
      'attachTableRenderers: renderer key "status" is not in the layout',
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
