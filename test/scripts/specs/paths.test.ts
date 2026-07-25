import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { projectRoot } from "#scripts/project-root.ts";
import { isFeaturePath, isSpecPath } from "#scripts/specs/paths.ts";

describe("Cucumber paths", () => {
  test("recognises project-relative and absolute spec paths", () => {
    expect(isSpecPath("specs")).toBe(true);
    expect(isSpecPath("specs/payments")).toBe(true);
    expect(isSpecPath(`${projectRoot}/specs/payments`)).toBe(true);
    expect(isSpecPath("test/specs/steps")).toBe(false);
  });

  test("recognises Feature paths with mixed separators", () => {
    expect(isFeaturePath("specs\\payments/example.feature")).toBe(true);
    expect(isFeaturePath("specs/payments/example.feature.md")).toBe(false);
  });
});
