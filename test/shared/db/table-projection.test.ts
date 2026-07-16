import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { col, defineTable, defineTableProjection } from "#shared/db/table.ts";

type ProjectionRow = {
  active: boolean;
  id: number;
  name: string;
  summary: string;
  tag: string;
};

const projectionTable = defineTable<ProjectionRow>({
  name: "projection_rows",
  primaryKey: "id",
  schema: {
    active: col.boolean(false),
    id: col.generated<number>(),
    name: col.transform(
      (value: string) => `stored:${value}`,
      (value: string) => value.replace("stored:", ""),
    ),
    summary: col.projected((value) => String(value)),
    tag: {
      read: (value, rowId) => `${value}:${String(rowId)}`,
    },
  },
});

describe("table projections", () => {
  test("builds explicit column SQL with an optional table alias", () => {
    const projection = defineTableProjection(projectionTable, ["id", "name"]);

    expect(projection.columnsSql()).toBe("id, name");
    expect(projection.columnsSql("row")).toBe("row.id, row.name");
  });

  test("reads only the selected columns through their table transforms", async () => {
    const projection = defineTableProjection(projectionTable, [
      "id",
      "name",
      "active",
    ]);

    expect(
      await projection.read({ active: 1, id: 7, name: "stored:Open" }),
    ).toEqual({ active: true, id: 7, name: "Open" });
  });

  test("reads several selected rows", async () => {
    const projection = defineTableProjection(projectionTable, ["id", "name"]);

    expect(
      await projection.readAll([
        { id: 1, name: "stored:First" },
        { id: 2, name: "stored:Second" },
      ]),
    ).toEqual([
      { id: 1, name: "First" },
      { id: 2, name: "Second" },
    ]);
  });

  test("uses each row's primary key while reading several rows", async () => {
    const projection = defineTableProjection(projectionTable, ["id", "tag"]);

    expect(
      await projection.readAll([
        { id: 11, tag: "first" },
        { id: 23, tag: "second" },
      ]),
    ).toEqual([
      { id: 11, tag: "first:11" },
      { id: 23, tag: "second:23" },
    ]);
  });

  test("runs projected column transforms when the selected value is missing", async () => {
    expect(
      await projectionTable.readColumn(
        "summary",
        undefined as unknown as string,
      ),
    ).toBe("undefined");
  });

  test("rejects columns that do not physically exist on the table", () => {
    expect(() => defineTableProjection(projectionTable, ["summary"])).toThrow(
      "Cannot select projected column summary from projection_rows",
    );
  });
});
