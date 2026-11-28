import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { schemaShape } from "#shared/rest/schema-shape.ts";

describe("schema shape", () => {
  test("reads the entries of an object in declaration order", () => {
    expect(
      schemaShape(v.object({ name: v.string(), seats: v.number() })),
    ).toEqual({
      entries: {
        name: { kind: "string" },
        seats: { kind: "number" },
      },
      kind: "object",
    });
  });

  test("keeps an optional wrapper and a nullable wrapper", () => {
    expect(schemaShape(v.optional(v.string()))).toEqual({
      kind: "optional",
      of: { kind: "string" },
    });
    expect(schemaShape(v.nullable(v.boolean()))).toEqual({
      kind: "nullable",
      of: { kind: "boolean" },
    });
  });

  test("reads an array item and a picklist's options", () => {
    expect(schemaShape(v.array(v.object({ id: v.number() })))).toEqual({
      item: { entries: { id: { kind: "number" } }, kind: "object" },
      kind: "array",
    });
    expect(schemaShape(v.picklist(["standard", "daily"]))).toEqual({
      kind: "picklist",
      options: ["standard", "daily"],
    });
  });

  test("keeps the valibot type of a schema it cannot name", () => {
    expect(schemaShape(v.date())).toEqual({ kind: "unknown", type: "date" });
  });
});
