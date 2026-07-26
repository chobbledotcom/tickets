import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { describe, it as test } from "@std/testing/bdd";
import { createFilePlan } from "#scripts/mutation/evaluate.ts";
import type {
  StaticAssetBuild,
  StaticBundle,
} from "#scripts/static-assets/session.ts";

describe("mutation file plan", () => {
  test("includes browser and state dependencies", async () => {
    const file = await Deno.makeTempFile({ suffix: ".ts" });
    await Deno.writeTextFile(file, "export const enabled = true;");
    const bundle: StaticBundle = {
      label: "Admin",
      options: { outfile: "admin.js" },
    };
    let rebuilt = 0;
    let restored: StaticBundle[] = [];
    const rebuilder: StaticAssetBuild = {
      affected: () => Promise.resolve([bundle]),
      dispose: () => Promise.resolve(),
      rebuild: () => {
        rebuilt += 1;
        return Promise.resolve(true);
      },
      restore: (bundles) => {
        restored = bundles;
        return Promise.resolve();
      },
    };
    try {
      const result = await createFilePlan(
        rebuilder,
        new Set([resolve(file)]),
        false,
        file,
        ["test/example.test.ts"],
      );
      expect(result.mutants.length).toBeGreaterThan(0);
      expect(result.rebuildTestState).toBe(true);
      expect(await result.assets?.rebuild()).toBe(true);
      await result.assets?.restore();
      expect(rebuilt).toBe(1);
      expect(restored).toEqual([bundle]);
    } finally {
      await Deno.remove(file);
    }
  });

  test("omits work for a type-only source", async () => {
    const file = await Deno.makeTempFile({ suffix: ".ts" });
    await Deno.writeTextFile(
      file,
      "export interface Example { value: string }",
    );
    try {
      const result = await createFilePlan(null, null, false, file, []);
      expect(result).toMatchObject({
        assets: null,
        directTestFiles: [],
        mutants: [],
        rebuildTestState: false,
      });
    } finally {
      await Deno.remove(file);
    }
  });

  test("keeps a mutable server source free of browser and state work", async () => {
    const file = await Deno.makeTempFile({ suffix: ".ts" });
    await Deno.writeTextFile(file, "export const enabled = true;");
    try {
      const result = await createFilePlan(null, new Set(), false, file, [
        "test/example.test.ts",
      ]);
      expect(result.assets).toBeNull();
      expect(result.rebuildTestState).toBe(false);
      expect(result.mutants.length).toBeGreaterThan(0);
    } finally {
      await Deno.remove(file);
    }
  });
});
