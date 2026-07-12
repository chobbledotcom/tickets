import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { setTestEnv } from "#test-utils/env.ts";
import {
  collectTestFiles,
  defaultGroupCount,
  GROUPS_DIR,
  mustRunAlone,
  planTestGroups,
  RUN_ALONE_MARKER,
  renderGroupEntry,
  shardRoundRobin,
  writeTestGroups,
} from "../../scripts/test-groups.ts";

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
      expect(source).toContain('import "../test/a.test.ts";');
      expect(source).toContain('import "../test/b.test.ts";');
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

  describe("defaultGroupCount", () => {
    test("gives each worker several groups to draw from", () => {
      expect(defaultGroupCount(4)).toBe(16);
    });

    test("never drops below the floor on small machines", () => {
      expect(defaultGroupCount(1)).toBe(8);
    });
  });

  describe("writeTestGroups", () => {
    /** A scratch project root with a test/ dir: one groupable file, one
     * global-hook file, and one non-test helper that must be ignored. */
    const makeScratchRoot = async (): Promise<string> => {
      const root = await Deno.makeTempDir({ prefix: "tickets-test-groups-" });
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
      return root;
    };

    test("collectTestFiles rejects a shared helper with a global hook", async () => {
      const root = await makeScratchRoot();
      try {
        await Deno.writeTextFile(
          `${root}/test/hooky-helper.ts`,
          "afterEach(() => {});\n",
        );
        await expect(collectTestFiles(root)).rejects.toThrow(
          "registers a global BDD hook",
        );
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    test("collectTestFiles finds .test.ts and .test.tsx files, sorted", async () => {
      const root = await makeScratchRoot();
      try {
        await Deno.writeTextFile(
          `${root}/test/component.test.tsx`,
          'describe("component", () => {});\n',
        );
        const files = await collectTestFiles(root);
        expect(files).toEqual([
          `${root}/test/component.test.tsx`,
          `${root}/test/global-hooks.test.ts`,
          `${root}/test/plain.test.ts`,
        ]);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    test("writes group entries, keeps solo files separate, and cleans up", async () => {
      const root = await makeScratchRoot();
      try {
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
        // The entries and (now empty) groups dir are gone.
        await expect(Deno.stat(`${root}/${GROUPS_DIR}`)).rejects.toThrow();
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    test("cleanup runs safely twice (files already removed)", async () => {
      const root = await makeScratchRoot();
      try {
        const groups = await writeTestGroups(root, 1);
        await groups.cleanup();
        await groups.cleanup(); // second pass finds nothing left — no throw
        await expect(Deno.stat(`${root}/${GROUPS_DIR}`)).rejects.toThrow();
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    test("cleanup leaves a groups dir holding someone else's files", async () => {
      const root = await makeScratchRoot();
      try {
        const groups = await writeTestGroups(root, 1);
        await Deno.writeTextFile(`${root}/${GROUPS_DIR}/keep.txt`, "mine");
        await groups.cleanup();
        expect(await Deno.readTextFile(`${root}/${GROUPS_DIR}/keep.txt`)).toBe(
          "mine",
        );
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    /** Run writeTestGroups with its default group count under `env`, and
     * expect the scratch root's single groupable file to land in one entry —
     * piles clamp to the file count whichever worker default applies. */
    const expectOneGroupEntryWithEnv = async (
      env: Record<string, string | undefined>,
    ): Promise<void> => {
      const root = await makeScratchRoot();
      const restoreEnv = setTestEnv(env);
      try {
        const groups = await writeTestGroups(root);
        expect(
          groups.runArgs.filter((arg) => arg.includes(GROUPS_DIR)),
        ).toHaveLength(1);
        await groups.cleanup();
      } finally {
        restoreEnv();
        await Deno.remove(root, { recursive: true });
      }
    };

    test("group count defaults from DENO_JOBS when set", async () => {
      await expectOneGroupEntryWithEnv({ DENO_JOBS: "2" });
    });

    test("group count falls back to the machine's cores without DENO_JOBS", async () => {
      await expectOneGroupEntryWithEnv({ DENO_JOBS: undefined });
    });
  });
});
