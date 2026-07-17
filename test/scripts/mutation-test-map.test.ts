import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { buildMutationTestMap } from "../../scripts/mutation/test-map.ts";
import { projectRoot } from "../../scripts/project-root.ts";

describe("mutation test map", () => {
  test("pairs each source with only its mirrored tests", () => {
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

  test("keeps unmatched tests for the integration stage", () => {
    const result = buildMutationTestMap(
      ["src/shared/a.ts"],
      ["test/shared/a.test.ts", "test/integration/app.test.ts"],
    );
    expect(result.integrationTestFiles).toEqual([
      "test/integration/app.test.ts",
    ]);
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

  test("does not treat a similarly named sibling as a direct test", () => {
    const result = buildMutationTestMap(
      ["src/db/attendees.ts"],
      ["test/db/attendees-notes.test.ts"],
    );
    expect(result.integrationTestFiles).toEqual([
      "test/db/attendees-notes.test.ts",
    ]);
    expect(result.targets[0]?.directTestFiles).toEqual([]);
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
});
