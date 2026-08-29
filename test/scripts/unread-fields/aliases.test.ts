import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { aliasPaths } from "#scripts/unread-fields/aliases.ts";

describe("aliasPaths", () => {
  test("gives a folder alias a wildcard on both sides", () => {
    expect(aliasPaths({ "#db/": "./src/shared/db/" })).toEqual({
      "#db/*": ["./src/shared/db/*"],
    });
  });

  test("leaves an alias naming one file exact", () => {
    expect(aliasPaths({ "#fp": "./src/fp.ts" })).toEqual({
      "#fp": ["./src/fp.ts"],
    });
  });

  test("ignores the npm and jsr entries beside them", () => {
    expect(
      aliasPaths({ "#fp": "./src/fp.ts", valibot: "npm:valibot@^1.4.1" }),
    ).toEqual({ "#fp": ["./src/fp.ts"] });
  });

  test("maps an empty import table to no paths", () => {
    expect(aliasPaths({})).toEqual({});
  });
});
