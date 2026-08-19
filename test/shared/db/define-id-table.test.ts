import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { defineIdTable } from "#db/define-id-table.ts";
import { col } from "#db/table.ts";

describe("defineIdTable", () => {
  const table = defineIdTable<{ id: number; name: string }, { name: string }>(
    "widgets",
    {
      id: col.generated<number>(),
      name: col.simple<string>(),
    },
  );

  test("builds a table keyed by id with the given name", () => {
    expect(table.name).toBe("widgets");
    expect(table.primaryKey).toBe("id");
  });

  test("carries the transactional builders defineTable guarantees", async () => {
    const statement = await table.insertStatement({ name: "Sprocket" });
    expect(statement.sql).toBe(
      "INSERT INTO widgets (name) VALUES (?) RETURNING id",
    );
    expect(statement.args).toEqual(["Sprocket"]);
  });
});
