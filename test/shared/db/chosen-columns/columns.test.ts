import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { chooseColumns } from "#db/chosen-columns.ts";
import { col, defineTable } from "#db/table.ts";

type SampleRow = {
  active: boolean;
  id: number;
  name: string;
  summary: string;
  tag: string;
};

const sampleTable = defineTable<SampleRow>({
  name: "sample_rows",
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

describe("chosen table columns", () => {
  test("builds explicit column SQL with an optional table alias", () => {
    const chosen = chooseColumns(sampleTable, ["id", "name"]);

    expect(chosen.columnsSql()).toBe("id, name");
    expect(chosen.columnsSql("row")).toBe("row.id, row.name");
  });

  test("a read of the table's own rows also selects the row's key", () => {
    // A column's read transform may name the row a bad value came from, so the
    // key has to come back with it — but only when it was not chosen already,
    // or the read would ask for the same column twice.
    expect(chooseColumns(sampleTable, ["name"]).readColumnsSql()).toBe(
      "name, id",
    );
    expect(chooseColumns(sampleTable, ["id", "name"]).readColumnsSql()).toBe(
      "id, name",
    );
    expect(chooseColumns(sampleTable, ["name"]).readColumnsSql("row")).toBe(
      "row.name, row.id",
    );
  });

  test("reads only the selected columns through their table transforms", async () => {
    const chosen = chooseColumns(sampleTable, ["id", "name", "active"]);

    expect(
      await chosen.read({ active: 1, id: 7, name: "stored:Open" }),
    ).toEqual({ active: true, id: 7, name: "Open" });
  });

  test("rejects a query row missing a selected column", async () => {
    const chosen = chooseColumns(sampleTable, ["id", "name"]);

    await expect(
      chosen.read({ id: 7 } as { id: number; name: string }),
    ).rejects.toThrow(
      "Chosen column name is missing from the sample_rows rows read back",
    );
  });

  test("reads several selected rows", async () => {
    const chosen = chooseColumns(sampleTable, ["id", "name"]);

    expect(
      await chosen.readAll([
        { id: 1, name: "stored:First" },
        { id: 2, name: "stored:Second" },
      ]),
    ).toEqual([
      { id: 1, name: "First" },
      { id: 2, name: "Second" },
    ]);
  });

  test("uses each row's primary key while reading several rows", async () => {
    const chosen = chooseColumns(sampleTable, ["id", "tag"]);

    expect(
      await chosen.readAll([
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
      await sampleTable.readColumn("summary", undefined as unknown as string),
    ).toBe("undefined");
  });

  test("rejects columns that do not physically exist on the table", () => {
    expect(() => chooseColumns(sampleTable, ["summary"])).toThrow(
      "Cannot select summary from sample_rows: it is not one of its columns",
    );
  });
});
