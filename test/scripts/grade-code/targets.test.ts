import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { describe, it as test } from "@std/testing/bdd";
import { resolveTargets } from "#scripts/grade-code/targets.ts";
import { CLEAN_CODE, depsOver } from "./support.ts";
import { HELPER_SOURCE, MODEL_SOURCE } from "./tla-support.ts";

const files = {
  "src/shared/sample.ts": CLEAN_CODE,
  "src/ui/client/sample.js": "export const value = 1;",
  "verification/Laws.tla": HELPER_SOURCE,
  "verification/Sample.tla": MODEL_SOURCE,
};

describe("mixed grading targets", () => {
  test("defaults to src only and accepts explicit model/helper files and directories", async () => {
    const deps = depsOver({ files });
    expect((await resolveTargets([], deps)).targets).toEqual([
      "src/shared/sample.ts",
      "src/ui/client/sample.js",
    ]);
    expect(
      (await resolveTargets(["verification"], deps)).targets.sort(),
    ).toEqual(["verification/Laws.tla", "verification/Sample.tla"]);
    expect(
      (await resolveTargets(["verification/Laws.tla"], deps)).targets,
    ).toEqual(["verification/Laws.tla"]);
  });

  test("normalizes and deduplicates overlapping mixed targets", async () => {
    const selected = await resolveTargets(
      [
        "./src/shared",
        "src/shared/sample.ts",
        "verification",
        "./verification/Laws.tla",
        resolve("verification/Sample.tla"),
      ],
      depsOver({ files }),
    );
    expect(selected.error).toBeNull();
    expect(selected.targets.sort()).toEqual([
      "src/shared/sample.ts",
      "verification/Laws.tla",
      "verification/Sample.tla",
    ]);
  });

  test("rejects escaped roots, non-source files and unsupported language/tree pairings", async () => {
    for (const path of [
      "verification/../scripts/secret.ts",
      "verification/../../secret.tla",
      "verification-other/Sample.tla",
      "src-other/sample.ts",
      "verification/data.json",
      "verification/generator.ts",
      "src/shared/Laws.tla",
    ]) {
      const selected = await resolveTargets(
        [path],
        depsOver({ files: { [path]: "source" } }),
      );
      expect(selected.targets).toEqual([]);
      expect(selected.error).not.toBeNull();
    }
  });

  test("validates collector output boundaries before any file can reach grading", async () => {
    for (const collected of [
      ["verification/../scripts/secret.ts"],
      ["src/shared/sample.ts"],
      ["verification/data.sqlite"],
      ["verification-other/Laws.tla"],
    ]) {
      const deps = depsOver({ files });
      deps.listFiles = () => Promise.resolve(collected);
      const selected = await resolveTargets(["verification"], deps);
      expect(selected.targets).toEqual([]);
      expect(selected.error).not.toBeNull();
    }
  });

  test("reports collection and symlink policy errors without a partial selection", async () => {
    const deps = depsOver({ files });
    deps.listFiles = () =>
      Promise.reject(new Error("symlink component verification/linked"));
    const selected = await resolveTargets(
      ["src/shared/sample.ts", "verification"],
      deps,
    );
    expect(selected.targets).toEqual([]);
    expect(selected.error).toContain("symlink component");
  });
});
