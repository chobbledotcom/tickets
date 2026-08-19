import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { scanTestTree } from "#scripts/test-tree-scan.ts";
import { tempDir } from "#test-utils/files.ts";

/** Write a small project on disk: a deno config with the alias map, and the
 *  named test-tree files. Returns the paths the scan needs. */
const writeProject = async (
  root: string,
  files: Record<string, string>,
): Promise<{ configPath: string; testRoot: string }> => {
  const configPath = `${root}/deno.json`;
  await Deno.writeTextFile(
    configPath,
    JSON.stringify({
      imports: { "#shared/": "./src/shared/", "#test/": `${root}/test/` },
    }),
  );
  for (const [path, text] of Object.entries(files)) {
    const full = `${root}/${path}`;
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(full, text);
  }
  return { configPath, testRoot: `${root}/test` };
};

describe("scanTestTree", () => {
  test("reports the sources a test reaches through its helper", async () => {
    using temp = tempDir();
    const { configPath, testRoot } = await writeProject(temp.path, {
      "test/helpers.ts": `import { db } from "#db/client.ts";`,
      "test/shared/a.test.ts": [
        `import { seed } from "../helpers.ts";`,
        `import { a } from "#shared/a.ts";`,
      ].join("\n"),
    });
    const scan = await scanTestTree({
      configPath,
      isTest: (path) => path.endsWith(".test.ts"),
      testRoot,
    });
    expect([...scan.subjectsOf(`${testRoot}/shared/a.test.ts`)].sort()).toEqual(
      ["src/shared/a.ts", "src/shared/db/client.ts"],
    );
  });

  test("defaults to this repo's own config and test tree", async () => {
    // isTest never matches, so this is the cheap walk: it proves the default
    // config path and test root resolve, without resolving every subject.
    const scan = await scanTestTree({ isTest: () => false });
    expect(scan.testTreeFiles.has("test/scripts/test-tree-scan.test.ts")).toBe(
      true,
    );
  });

  test("reports no subjects for a path the scan did not select", async () => {
    using temp = tempDir();
    const { configPath, testRoot } = await writeProject(temp.path, {
      "test/helpers.ts": `import { db } from "#db/client.ts";`,
      "test/shared/a.test.ts": `import { a } from "#shared/a.ts";`,
    });
    const scan = await scanTestTree({
      configPath,
      isTest: (path) => path.endsWith(".test.ts"),
      testRoot,
    });
    expect(scan.subjectsOf(`${testRoot}/helpers.ts`)).toEqual([]);
  });

  test("collects every file in the test tree, helpers included", async () => {
    using temp = tempDir();
    const { configPath, testRoot } = await writeProject(temp.path, {
      "test/helpers.ts": "export const seed = () => {};",
      "test/shared/a.test.ts": `import { a } from "#shared/a.ts";`,
    });
    const scan = await scanTestTree({
      configPath,
      isTest: (path) => path.endsWith(".test.ts"),
      testRoot,
    });
    expect([...scan.testTreeFiles].sort()).toEqual([
      `${testRoot}/helpers.ts`,
      `${testRoot}/shared/a.test.ts`,
    ]);
  });

  test("hands back a reader that serves the files it already read", async () => {
    using temp = tempDir();
    const { configPath, testRoot } = await writeProject(temp.path, {
      "test/shared/a.test.ts": `import { a } from "#shared/a.ts";`,
    });
    const scan = await scanTestTree({
      configPath,
      isTest: (path) => path.endsWith(".test.ts"),
      testRoot,
    });
    expect(await scan.readText(`${testRoot}/shared/a.test.ts`)).toBe(
      `import { a } from "#shared/a.ts";`,
    );
  });
});
