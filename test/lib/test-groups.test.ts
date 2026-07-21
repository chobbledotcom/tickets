import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { rethrowUnlessNotFound } from "#scripts/not-found.ts";
import {
  collectTestFiles,
  defaultGroupCount,
  GROUPS_DIR,
  mustRunAlone,
  parseWorkerCount,
  planTestGroups,
  RUN_ALONE_MARKER,
  renderGroupEntry,
  rethrowUnlessLeftoverDir,
  shardRoundRobin,
  writeTestGroups,
} from "#scripts/test-groups.ts";
import { withEnv } from "#test-utils/env.ts";
import { withTempDir } from "#test-utils/files.ts";

describe("test-groups", () => {
  describe("mustRunAlone", () => {
    test("a module-level hook forces a solo isolate", () => {
      expect(
        mustRunAlone('beforeAll(() => {});\ndescribe("x", () => {});'),
      ).toBe(true);
      expect(mustRunAlone("afterEach(() => {});")).toBe(true);
    });

    test("hooks inside a describe do not force a solo isolate", () => {
      expect(
        mustRunAlone('describe("x", () => {\n  beforeEach(() => {});\n});'),
      ).toBe(false);
    });

    test("the run-alone marker forces a solo isolate", () => {
      expect(mustRunAlone(`// ${RUN_ALONE_MARKER}\ndescribe("x");`)).toBe(true);
    });

    test("a plain test file can share an isolate", () => {
      expect(mustRunAlone('describe("x", () => {});')).toBe(false);
    });
  });

  describe("shardRoundRobin", () => {
    test("deals items round-robin so pile sizes differ by at most one", () => {
      const piles = shardRoundRobin([1, 2, 3, 4, 5, 6, 7], 3);
      expect(piles).toEqual([
        [1, 4, 7],
        [2, 5],
        [3, 6],
      ]);
    });

    test("never makes more piles than there are items", () => {
      expect(shardRoundRobin(["a", "b"], 5)).toEqual([["a"], ["b"]]);
    });

    test("clamps a zero group count to one pile", () => {
      expect(shardRoundRobin(["a", "b"], 0)).toEqual([["a", "b"]]);
    });
  });

  describe("renderGroupEntry", () => {
    test("renders one import per member file", () => {
      const source = renderGroupEntry([
        "../test/a.test.ts",
        "../test/b.test.ts",
      ]);
      // Each import sits on its own line, so a generated entry stays readable
      // when a group needs eyeballing.
      const lines = source.split("\n");
      expect(lines).toContain('import "../test/a.test.ts";');
      expect(lines).toContain('import "../test/b.test.ts";');
      expect(source).toContain("do not edit");
    });
  });

  describe("planTestGroups", () => {
    test("splits solo files out and shards the rest", () => {
      const plan = planTestGroups(
        [
          { path: "a.test.ts", runsAlone: false },
          { path: "b.test.ts", runsAlone: true },
          { path: "c.test.ts", runsAlone: false },
        ],
        1,
      );
      expect(plan.grouped).toEqual([["a.test.ts", "c.test.ts"]]);
      expect(plan.solo).toEqual(["b.test.ts"]);
    });
  });

  describe("parseWorkerCount", () => {
    test("uses a positive whole number and falls back on anything else", () => {
      expect(parseWorkerCount("2", 8)).toBe(2);
      expect(parseWorkerCount("1", 8)).toBe(1);
      expect(parseWorkerCount(undefined, 8)).toBe(8);
      expect(parseWorkerCount("", 8)).toBe(8); // Number("") is 0 — not positive
      expect(parseWorkerCount("0", 8)).toBe(8);
      expect(parseWorkerCount("-3", 8)).toBe(8);
      expect(parseWorkerCount("2.5", 8)).toBe(8);
      expect(parseWorkerCount("abc", 8)).toBe(8);
    });
  });

  describe("defaultGroupCount", () => {
    test("gives each worker several groups to draw from", () => {
      expect(defaultGroupCount(4)).toBe(16);
    });

    test("never drops below the floor on small machines", () => {
      expect(defaultGroupCount(1)).toBe(8);
    });
  });

  describe("cleanup error filters", () => {
    test("rethrowUnlessNotFound lets only a missing file pass", () => {
      expect(() =>
        rethrowUnlessNotFound(new Deno.errors.NotFound("gone")),
      ).not.toThrow();
      expect(() => rethrowUnlessNotFound(new Error("boom"))).toThrow("boom");
    });

    test("rethrowUnlessLeftoverDir lets only the expected leftovers pass", () => {
      expect(() =>
        rethrowUnlessLeftoverDir(new Deno.errors.NotFound("gone")),
      ).not.toThrow();
      expect(() =>
        rethrowUnlessLeftoverDir(
          new Error("Directory not empty (os error 39): remove '/x'"),
        ),
      ).not.toThrow();
      expect(() => rethrowUnlessLeftoverDir(new Error("boom"))).toThrow("boom");
    });
  });

  describe("writeTestGroups", () => {
    /** A scratch project root with a test/ dir: one groupable file, one
     * global-hook file, and one non-test helper that must be ignored. */
    const withScratchRoot = <Result>(
      run: (root: string) => Result | Promise<Result>,
    ): Promise<Result> =>
      withTempDir(
        async (root) => {
          await Deno.mkdir(`${root}/test`, { recursive: true });
          await Deno.writeTextFile(
            `${root}/test/plain.test.ts`,
            'describe("plain", () => {});\n',
          );
          await Deno.writeTextFile(
            `${root}/test/global-hooks.test.ts`,
            "beforeAll(() => {});\n",
          );
          await Deno.writeTextFile(
            `${root}/test/helper.ts`,
            "export const x = 1;\n",
          );
          return await run(root);
        },
        { prefix: "tickets-test-groups-" },
      );

    test("collectTestFiles rejects a shared helper with a global hook", async () => {
      await withScratchRoot(async (root) => {
        await Deno.writeTextFile(
          `${root}/test/hooky-helper.ts`,
          "afterEach(() => {});\n",
        );
        await expect(collectTestFiles(root)).rejects.toThrow(
          "registers a global BDD hook — export a setup function and call it " +
            "from each test file's own suite instead",
        );
      });
    });

    test("collectTestFiles finds .test.ts and .test.tsx files, sorted", async () => {
      await withScratchRoot(async (root) => {
        await Deno.writeTextFile(
          `${root}/test/component.test.tsx`,
          'describe("component", () => {});\n',
        );
        // A test file OUTSIDE test/ must not be picked up — the walk is
        // rooted at the test directory, not the whole project.
        await Deno.writeTextFile(
          `${root}/stray.test.ts`,
          'describe("stray", () => {});\n',
        );
        const files = await collectTestFiles(root);
        expect(files).toEqual([
          `${root}/test/component.test.tsx`,
          `${root}/test/global-hooks.test.ts`,
          `${root}/test/plain.test.ts`,
        ]);
      });
    });

    test("writes group entries, keeps solo files separate, and cleans up", async () => {
      await withScratchRoot(async (root) => {
        const groups = await writeTestGroups(root, 2);

        // One groupable file → one group entry; the global-hook file is solo.
        expect(groups.runArgs).toEqual([
          `${root}/${GROUPS_DIR}/group-0.test.ts`,
          `${root}/test/global-hooks.test.ts`,
        ]);
        expect(groups.testFiles).toEqual([
          `${root}/test/global-hooks.test.ts`,
          `${root}/test/plain.test.ts`,
        ]);
        const entry = await Deno.readTextFile(groups.runArgs[0]!);
        expect(entry).toContain('import "../test/plain.test.ts";');

        await groups.cleanup();
        await groups.cleanup(); // a second pass finds nothing left — no throw
        // The entries and (now empty) groups dir are gone.
        await expect(Deno.stat(`${root}/${GROUPS_DIR}`)).rejects.toThrow();
      });
    });

    test("cleanup leaves a groups dir holding someone else's files", async () => {
      await withScratchRoot(async (root) => {
        const groups = await writeTestGroups(root, 1);
        await Deno.writeTextFile(`${root}/${GROUPS_DIR}/keep.txt`, "mine");
        await groups.cleanup();
        expect(await Deno.readTextFile(`${root}/${GROUPS_DIR}/keep.txt`)).toBe(
          "mine",
        );
        // A later run must reuse that leftover dir rather than choke on it.
        const again = await writeTestGroups(root, 1);
        expect(again.runArgs[0]).toContain(GROUPS_DIR);
        await again.cleanup();
      });
    });

    /** Run writeTestGroups with its default group count under `env`, and
     * expect the scratch root's single groupable file to land in one entry —
     * piles clamp to the file count whichever worker default applies. */
    const expectOneGroupEntryWithEnv = async (
      env: Record<string, string | undefined>,
    ): Promise<void> => {
      using _env = withEnv(env);
      await withScratchRoot(async (root) => {
        const groups = await writeTestGroups(root);
        expect(
          groups.runArgs.filter((arg) => arg.includes(GROUPS_DIR)),
        ).toHaveLength(1);
        await groups.cleanup();
      });
    };

    test("group count defaults from DENO_JOBS when set", async () => {
      await expectOneGroupEntryWithEnv({ DENO_JOBS: "2" });
    });

    test("group count falls back to the machine's cores without DENO_JOBS", async () => {
      await expectOneGroupEntryWithEnv({ DENO_JOBS: undefined });
    });
  });
});
