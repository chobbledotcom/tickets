import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { countJavaScriptAstNodes } from "../../../../scripts/bench/bundle-composition/javascript-ast.ts";

describe("bundle JavaScript AST", () => {
  test("counts the syntax nodes the parser builds", () => {
    expect(countJavaScriptAstNodes("const answer = 1 + 2;")).toBe(7);
  });

  test("rejects invalid bundle JavaScript", () => {
    expect(() => countJavaScriptAstNodes("const =")).toThrow(
      "Bundle JavaScript is invalid: Unexpected token",
    );
  });
});
