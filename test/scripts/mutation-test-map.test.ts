import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  buildMutationTestMap,
  requireDirectMutationTests,
} from "#scripts/mutation/test-map.ts";
import { projectRoot } from "#scripts/project-root.ts";

describe("mutation test map", () => {
  test("does not use another source's mirrored tests as fallback tests", () => {
    expect(
      buildMutationTestMap(
        ["src/shared/a.ts", "src/shared/b.tsx"],
        [
          "test/shared/a.test.ts",
          "test/shared/b/first.test.ts",
          "test/shared/b/second.test.tsx",
        ],
      ),
    ).toEqual({
      integrationTestFiles: [],
      targets: [
        {
          directTestFiles: ["test/shared/a.test.ts"],
          sourceFile: "src/shared/a.ts",
        },
        {
          directTestFiles: [
            "test/shared/b/first.test.ts",
            "test/shared/b/second.test.tsx",
          ],
          sourceFile: "src/shared/b.tsx",
        },
      ],
    });
  });

  test("keeps explicit integration tests for the later stage", () => {
    const result = buildMutationTestMap(
      ["src/shared/a.ts"],
      ["test/shared/a.test.ts", "test/integration/app.test.ts"],
    );
    expect(result.integrationTestFiles).toEqual([
      "test/integration/app.test.ts",
    ]);
  });

  test("keeps a mirrored integration path in the integration stage", () => {
    expect(
      buildMutationTestMap(
        ["src/integration/app.ts"],
        ["test/integration/app.test.ts"],
      ),
    ).toEqual({
      integrationTestFiles: ["test/integration/app.test.ts"],
      targets: [{ directTestFiles: [], sourceFile: "src/integration/app.ts" }],
    });
  });

  test("gives a child test to the child source", () => {
    const result = buildMutationTestMap(
      ["src/db/attendees.ts", "src/db/attendees/kind.ts"],
      ["test/db/attendees/kind.test.ts"],
    );
    expect(result.targets).toEqual([
      { directTestFiles: [], sourceFile: "src/db/attendees.ts" },
      {
        directTestFiles: ["test/db/attendees/kind.test.ts"],
        sourceFile: "src/db/attendees/kind.ts",
      },
    ]);
  });

  test("supports JavaScript sources and removes duplicate paths", () => {
    const result = buildMutationTestMap(
      ["src/ui/scanner.js", "src/ui/scanner.js"],
      ["test/ui/scanner.test.ts", "test/ui/scanner.test.ts"],
    );
    expect(result.targets).toEqual([
      {
        directTestFiles: ["test/ui/scanner.test.ts"],
        sourceFile: "src/ui/scanner.js",
      },
    ]);
  });

  test("rejects a similarly named sibling instead of treating it as integration", () => {
    expect(() =>
      buildMutationTestMap(
        ["src/db/attendees.ts"],
        ["test/db/attendees-notes.test.ts"],
      ),
    ).toThrow("Mutation tests must mirror a selected source");
  });

  test("maps absolute paths inside the project", () => {
    const result = buildMutationTestMap(
      [`${projectRoot}/src/shared/a.ts`],
      [`${projectRoot}/test/shared/a.test.ts`],
    );
    expect(result.targets[0]?.directTestFiles).toEqual([
      `${projectRoot}/test/shared/a.test.ts`,
    ]);
  });

  test("maps paths with mixed Windows and Unix separators", () => {
    const result = buildMutationTestMap(
      ["src\\shared/a.ts"],
      ["test/shared\\a.test.ts", "test\\integration/app.test.ts"],
    );
    expect(result).toEqual({
      integrationTestFiles: ["test\\integration/app.test.ts"],
      targets: [
        {
          directTestFiles: ["test/shared\\a.test.ts"],
          sourceFile: "src\\shared/a.ts",
        },
      ],
    });
  });

  test("rejects misplaced legacy tests with every offending path", () => {
    expect(() =>
      buildMutationTestMap(
        ["src/shared/a.ts"],
        ["test/lib/a.test.ts", "test/shared/other.test.ts"],
      ),
    ).toThrow("test/lib/a.test.ts\ntest/shared/other.test.ts");
  });

  test("keeps explicit end-to-end tests in the integration stage", () => {
    const result = buildMutationTestMap(
      ["src/shared/a.ts"],
      ["test/shared/a.test.ts", "test/e2e/booking.test.ts"],
    );
    expect(result.integrationTestFiles).toEqual(["test/e2e/booking.test.ts"]);
  });

  test("requires mutable sources to have a mirror-located direct test", () => {
    expect(() => requireDirectMutationTests("src/shared/a.ts", 1, [])).toThrow(
      "No direct test mirrors src/shared/a.ts",
    );
  });

  test("allows sources without operators to omit a direct test", () => {
    expect(requireDirectMutationTests("src/shared/types.ts", 0, [])).toBe(
      undefined,
    );
  });
});
