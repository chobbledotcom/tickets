import { basename } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  entryImport,
  MAX_FILES_PER_ENTRY,
  planIsolateEntries,
  shardForEntries,
  splitByIsolateSharing,
} from "#scripts/mutation/isolate-entry.ts";
import { GROUPS_DIR } from "#scripts/test-groups.ts";

/** A test file body that can share an isolate: its hook sits inside a suite. */
const groupable = 'describe("x", () => {\n  beforeAll(() => {});\n});\n';

/** A test file body that cannot: the hook is registered at module level. */
const globalHook = 'beforeAll(() => {});\ndescribe("x", () => {});\n';

/** Build a throwaway project root holding the given test files. */
const withFiles = async (
  files: Record<string, string>,
): Promise<{ paths: string[]; root: string }> => {
  const root = await Deno.makeTempDir();
  const paths: string[] = [];
  for (const [name, body] of Object.entries(files)) {
    await Deno.writeTextFile(`${root}/${name}`, body);
    paths.push(`${root}/${name}`);
  }
  return { paths, root };
};

describe("shardForEntries", () => {
  test("keeps every path, in order, across shards", () => {
    const paths = Array.from({ length: 5 }, (_, i) => `f${i}.ts`);
    expect(shardForEntries(paths, 2)).toEqual([
      ["f0.ts", "f1.ts"],
      ["f2.ts", "f3.ts"],
      ["f4.ts"],
    ]);
  });

  test("caps a shard at MAX_FILES_PER_ENTRY by default", () => {
    const paths = Array.from(
      { length: MAX_FILES_PER_ENTRY + 1 },
      (_, i) => `f${i}.ts`,
    );
    const shards = shardForEntries(paths);
    expect(shards.map((shard) => shard.length)).toEqual([
      MAX_FILES_PER_ENTRY,
      1,
    ]);
  });

  test("returns no shards for no paths", () => {
    expect(shardForEntries([])).toEqual([]);
  });
});

describe("entryImport", () => {
  test("climbs out of the entries directory to a project-relative path", () => {
    expect(entryImport("/repo", "/repo/test/a.test.ts")).toBe(
      "../test/a.test.ts",
    );
  });

  test("treats a relative member as already project-relative", () => {
    expect(entryImport("/repo", "test/a.test.ts")).toBe("../test/a.test.ts");
  });
});

describe("splitByIsolateSharing", () => {
  test("sends a file with a global hook to its own isolate", () => {
    expect(
      splitByIsolateSharing([
        { path: "a.test.ts", source: groupable },
        { path: "b.test.ts", source: globalHook },
      ]),
    ).toEqual({ shareable: ["a.test.ts"], solo: ["b.test.ts"] });
  });

  test("honours the run-alone marker", () => {
    expect(
      splitByIsolateSharing([
        { path: "a.test.ts", source: "// test-groups: run-alone\n" },
      ]),
    ).toEqual({ shareable: [], solo: ["a.test.ts"] });
  });
});

describe("planIsolateEntries", () => {
  test("hands a single file through without writing an entry", async () => {
    const { paths, root } = await withFiles({ "a.test.ts": groupable });
    const plan = await planIsolateEntries(paths, root);
    expect(plan.runArgs).toEqual(paths);
    await plan.cleanup();
    await expect(Deno.stat(`${root}/${GROUPS_DIR}`)).rejects.toThrow();
    await Deno.remove(root, { recursive: true });
  });

  test("hands no files through without writing an entry", async () => {
    const plan = await planIsolateEntries([]);
    expect(plan.runArgs).toEqual([]);
    await plan.cleanup();
  });

  test("replaces several shareable files with one entry that imports them", async () => {
    const { paths, root } = await withFiles({
      "a.test.ts": groupable,
      "b.test.ts": groupable,
    });
    const plan = await planIsolateEntries(paths, root);

    expect(plan.runArgs).toHaveLength(1);
    const entry = plan.runArgs[0]!;
    expect(entry.startsWith(`${root}/${GROUPS_DIR}/`)).toBe(true);
    const body = await Deno.readTextFile(entry);
    for (const path of paths) {
      expect(body).toContain(`import "../${basename(path)}";`);
    }

    await plan.cleanup();
    await expect(Deno.stat(entry)).rejects.toThrow(Deno.errors.NotFound);
    await Deno.remove(root, { recursive: true });
  });

  test("runs a file with a global hook alongside the entry, not inside it", async () => {
    const { paths, root } = await withFiles({
      "a.test.ts": groupable,
      "b.test.ts": groupable,
      "c.test.ts": globalHook,
    });
    const plan = await planIsolateEntries(paths, root);

    expect(plan.runArgs).toHaveLength(2);
    expect(plan.runArgs.at(-1)).toBe(`${root}/c.test.ts`);
    const body = await Deno.readTextFile(plan.runArgs[0]!);
    expect(body).not.toContain("c.test.ts");

    await plan.cleanup();
    await Deno.remove(root, { recursive: true });
  });

  test("hands files through when only one of them can share an isolate", async () => {
    const { paths, root } = await withFiles({
      "a.test.ts": groupable,
      "b.test.ts": globalHook,
    });
    const plan = await planIsolateEntries(paths, root);
    expect(plan.runArgs).toEqual(paths);
    await plan.cleanup();
    await Deno.remove(root, { recursive: true });
  });

  test("splits more files than one entry may hold into several entries", async () => {
    const bodies = Object.fromEntries(
      Array.from({ length: MAX_FILES_PER_ENTRY + 2 }, (_, i) => [
        `f${i}.test.ts`,
        groupable,
      ]),
    );
    const { paths, root } = await withFiles(bodies);
    const plan = await planIsolateEntries(paths, root);

    expect(plan.runArgs).toHaveLength(2);
    const imports = await Promise.all(
      plan.runArgs.map((entry) => Deno.readTextFile(entry)),
    );
    const imported = imports.flatMap((body) =>
      [...body.matchAll(/import "\.\.\/(.+)";/g)].map((match) => match[1]),
    );
    expect(imported).toEqual(paths.map((path) => basename(path)));

    await plan.cleanup();
    await Deno.remove(root, { recursive: true });
  });

  test("cleanup tolerates an entry that is already gone", async () => {
    const { paths, root } = await withFiles({
      "a.test.ts": groupable,
      "b.test.ts": groupable,
    });
    const plan = await planIsolateEntries(paths, root);
    await Deno.remove(plan.runArgs[0]!);
    await plan.cleanup();
    await Deno.remove(root, { recursive: true });
  });

  test("cleanup surfaces a failure that is not a missing entry", async () => {
    const { paths, root } = await withFiles({
      "a.test.ts": groupable,
      "b.test.ts": groupable,
    });
    const plan = await planIsolateEntries(paths, root);
    // A directory in place of the entry file fails removal for a different
    // reason, so cleanup must not swallow it.
    await Deno.remove(plan.runArgs[0]!);
    await Deno.mkdir(plan.runArgs[0]!);
    await Deno.writeTextFile(`${plan.runArgs[0]!}/held.txt`, "x");
    await expect(plan.cleanup()).rejects.toThrow();
    await Deno.remove(root, { recursive: true });
  });
});
