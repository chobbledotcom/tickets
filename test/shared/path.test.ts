import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { normalizePath } from "#shared/path.ts";

test("normalizes non-root paths without changing root", () => {
  expect([
    normalizePath("/"),
    normalizePath("/scheduled"),
    normalizePath("/scheduled/"),
    normalizePath("/scheduled///"),
  ]).toEqual(["/", "/scheduled", "/scheduled", "/scheduled"]);
});
