import { assertNotReached } from "@std/assert";
import { expect } from "@std/expect";
import { dirname, join, resolve } from "@std/path";
import { describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { denoCliDeps, runGradeCodeCli } from "#scripts/grade-code/cli.ts";
import { VERIFICATION_MODULES } from "#scripts/verify-models/registry.ts";
import { tempDir } from "#test-utils/files.ts";
import { CLEAN_CODE, ioWith } from "./support.ts";

describe("denoCliDeps", () => {
  test("reads, classifies and writes real source files", async () => {
    using dir = tempDir();
    const code = `${dir.path}/code.ts`;
    await Deno.writeTextFile(code, CLEAN_CODE);
    const deps = denoCliDeps();
    expect(await deps.stat(dir.path)).toBe("dir");
    expect(await deps.stat(code)).toBe("file");
    expect(await deps.stat(`${dir.path}/gone.ts`)).toBe("missing");
    expect(await deps.grade.readFile(code)).toBe(CLEAN_CODE);
    await deps.writeTextFile(`${dir.path}/out.txt`, "kept");
    expect(await Deno.readTextFile(`${dir.path}/out.txt`)).toBe("kept");
  });

  test("selects exactly authored scripts from a mixed isolated tree", async () => {
    using dir = tempDir();
    const names = [
      "entry.ts",
      "view.tsx",
      "nested/client.js",
      "nested/module.mjs",
      "legacy.cjs",
      "types.mts",
      "worker.cts",
      "component.jsx",
      "notes.md",
      "data.json",
      "Laws.tla",
      "ui/static/bundle.js",
      "migrations/schema/columns.ts",
    ];
    for (const name of names) {
      const path = join(dir.path, name);
      await Deno.mkdir(dirname(path), { recursive: true });
      await Deno.writeTextFile(path, "");
    }
    expect(await denoCliDeps().listFiles(dir.path)).toEqual(
      [
        "component.jsx",
        "entry.ts",
        "legacy.cjs",
        "nested/client.js",
        "nested/module.mjs",
        "types.mts",
        "view.tsx",
        "worker.cts",
      ].map((name) => join(dir.path, name)),
    );
  });

  test("selects every maintained model and pure helper with either root spelling", async () => {
    const expected = VERIFICATION_MODULES.map((entry) =>
      resolve("verification", `${entry.module}.tla`),
    ).sort();
    const deps = denoCliDeps();
    for (const root of ["verification", "verification/"]) {
      expect(await deps.listFiles(root)).toEqual(expected);
    }
  });

  test("the clock and delay respect the same elapsed time", async () => {
    const start = Date.UTC(2026, 0, 1);
    using time = new FakeTime(start);
    const deps = denoCliDeps();
    let completed = false;
    const pending = deps.grade.sleep(10).then(() => {
      completed = true;
    });
    await time.tickAsync(9);
    expect({ completed, now: deps.grade.now() }).toEqual({
      completed: false,
      now: start + 9,
    });
    await time.tickAsync(1);
    await pending;
    expect({ completed, now: deps.grade.now() }).toEqual({
      completed: true,
      now: start + 10,
    });
  });

  test("the real CLI grades a source without a secret or paid request", async () => {
    const deps = denoCliDeps();
    deps.readSecret = assertNotReached;
    deps.grade.fetchText = assertNotReached;
    const file = "src/shared/price-modifier.ts";
    const { io, out } = ioWith([file, "--no-jev", "--json"]);
    expect(await runGradeCodeCli(io, deps)).toBe(0);
    expect(JSON.parse(out.join("\n"))).toEqual([
      expect.objectContaining({
        error: null,
        file,
        jev: null,
        kind: "shared",
      }),
    ]);
  });
});
