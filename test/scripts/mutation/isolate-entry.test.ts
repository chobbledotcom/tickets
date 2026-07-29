import { basename } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  entryCountFor,
  MAX_FILES_PER_ENTRY,
  planIsolateEntries,
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

describe("entryCountFor", () => {
  test("keeps one entry while the files fit in one isolate", () => {
    expect(entryCountFor(MAX_FILES_PER_ENTRY)).toBe(1);
  });

  test("adds an entry as soon as they do not fit", () => {
    expect(entryCountFor(MAX_FILES_PER_ENTRY + 1)).toBe(2);
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
    // Membership, not order: the files are dealt across entries, and what
    // matters is that each one is run exactly once.
    expect(imported.sort()).toEqual(paths.map((path) => basename(path)).sort());

    await plan.cleanup();
    await Deno.remove(root, { recursive: true });
  });

  /** Plan two shareable files, disturb the first entry, then clean up —
   *  returning the error cleanup threw, or null when it succeeded. */
  const cleanupErrorAfter = async (
    disturb: (entry: string) => Promise<void>,
  ): Promise<unknown> => {
    const { paths, root } = await withFiles({
      "a.test.ts": groupable,
      "b.test.ts": groupable,
    });
    const plan = await planIsolateEntries(paths, root);
    await disturb(plan.runArgs[0]!);
    try {
      await plan.cleanup();
      return null;
    } catch (error) {
      return error;
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  };

  test("cleanup tolerates an entry that is already gone", async () => {
    expect(await cleanupErrorAfter((entry) => Deno.remove(entry))).toBeNull();
  });

  test("cleanup surfaces a failure that is not a missing entry", async () => {
    // A directory in place of the entry file fails removal for a different
    // reason, so cleanup must not swallow it.
    const error = await cleanupErrorAfter(async (entry) => {
      await Deno.remove(entry);
      await Deno.mkdir(entry);
      await Deno.writeTextFile(`${entry}/held.txt`, "x");
    });
    expect(error).toBeInstanceOf(Error);
  });
});
