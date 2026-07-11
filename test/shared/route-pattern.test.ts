import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  compileRoutePathPattern,
  routePathPatternToRegex,
} from "#shared/route-pattern.ts";

describe("compileRoutePathPattern", () => {
  test("keeps parameter names, captures, and numeric conversions aligned", () => {
    const compiled = compileRoutePathPattern(
      "/admin/:id/options/:optionId/:slug/:tab",
    );
    const match = compiled.regex.exec(
      "/admin/7/options/11/summer-sale/details",
    );
    expect(compiled.paramNames).toEqual(["id", "optionId", "slug", "tab"]);
    expect([...compiled.numericParams]).toEqual(["id", "optionId"]);
    expect(match?.slice(1)).toEqual(["7", "11", "summer-sale", "details"]);
  });

  test("rejects invalid numeric and slug parameters", () => {
    const regex = routePathPatternToRegex("/admin/:id/:slug");
    expect(regex.test("/admin/not-a-number/valid-slug")).toBe(false);
    expect(regex.test("/admin/7/invalid.slug")).toBe(false);
  });

  test("escapes literals and anchors the complete path", () => {
    const regex = routePathPatternToRegex("/files/:id.json");
    expect(regex.test("/files/7.json")).toBe(true);
    expect(regex.test("/files/7xjson")).toBe(false);
    expect(regex.test("/prefix/files/7.json")).toBe(false);
  });
});
