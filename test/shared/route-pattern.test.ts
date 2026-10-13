import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  compileRoutePathPattern,
  routePathPatternToRegex,
  routeServesSlug,
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

describe("routeServesSlug", () => {
  test("serves the slug shapes the public routes match", () => {
    expect(routeServesSlug("summer-sale")).toBe(true);
    expect(routeServesSlug("plans+pricing")).toBe(true);
  });

  test("rejects a trailing line terminator the URL parsing drops", () => {
    // JS `$` matches before one final newline. URL parsing drops the
    // newline, so the location cannot name the stored page.
    expect(routeServesSlug("plans\n")).toBe(false);
    expect(routeServesSlug("plans\r\n")).toBe(false);
    expect(routeServesSlug("")).toBe(false);
  });
});
