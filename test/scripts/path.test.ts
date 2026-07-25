import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  inProjectFolders,
  normalizePath,
  relativeToProject,
} from "#scripts/path.ts";
import { projectRoot } from "#scripts/project-root.ts";

describe("script paths", () => {
  test("normalises separators and project-relative paths", () => {
    expect(normalizePath("specs\\payments/example.feature")).toBe(
      "specs/payments/example.feature",
    );
    expect(relativeToProject(`${projectRoot}/specs/example.feature`)).toBe(
      "specs/example.feature",
    );
    expect(relativeToProject("./specs\\example.feature")).toBe(
      "specs/example.feature",
    );
  });

  test("matches project folders and their children", () => {
    const inSpecsOrSource = inProjectFolders(["src", "specs"]);
    expect(inSpecsOrSource("specs")).toBe(true);
    expect(inSpecsOrSource("specs/payments")).toBe(true);
    expect(inSpecsOrSource("test/specs")).toBe(false);
  });
});
