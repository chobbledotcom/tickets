import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { previewNames, SCRIPT_NAME_PREFIX } from "#scripts/preview/names.ts";

describe("previewNames", () => {
  test("names the script and the database from the branch", async () => {
    const names = await previewNames("feature/Add-Tickets");

    expect(names.scriptName).toMatch(
      /^Tickets - preview-feature-add-tickets-[0-9a-f]{6}$/,
    );
    expect(names.databaseName).toMatch(/^pv-[0-9a-f]{12}$/);
  });

  test("keeps the database name within the 16 characters Bunny allows", async () => {
    for (const branch of ["main", "x".repeat(200), "///", "Ünï/code"]) {
      const { databaseName } = await previewNames(branch);
      expect(databaseName).toHaveLength(15);
    }
  });

  test("gives the same names for the same branch", async () => {
    expect(await previewNames("fix/a")).toEqual(await previewNames("fix/a"));
  });

  test("keeps two branches with one slug apart", async () => {
    const first = await previewNames("feature/a-b");
    const second = await previewNames("feature-a-b");

    expect(first.scriptName).not.toBe(second.scriptName);
    expect(first.databaseName).not.toBe(second.databaseName);
  });

  test("cuts a long branch name to a fixed length", async () => {
    const { scriptName } = await previewNames("x".repeat(200));

    expect(scriptName).toBe(
      `${SCRIPT_NAME_PREFIX}${"x".repeat(30)}-${scriptName.slice(-6)}`,
    );
  });

  test("drops dashes at the cut and at both ends", async () => {
    const { scriptName } = await previewNames(`--${"a".repeat(29)}/b--`);

    expect(scriptName).toMatch(/^Tickets - preview-a{29}-[0-9a-f]{6}$/);
  });

  test("names a branch with no letters or digits by its hash alone", async () => {
    const { scriptName } = await previewNames("///");

    expect(scriptName).toMatch(/^Tickets - preview-[0-9a-f]{6}$/);
  });

  test("starts every script name with the delete prefix", async () => {
    for (const branch of ["main", "a/b", "///", "Ünï/code"]) {
      const { scriptName } = await previewNames(branch);
      expect(scriptName.startsWith(SCRIPT_NAME_PREFIX)).toBe(true);
    }
  });
});
