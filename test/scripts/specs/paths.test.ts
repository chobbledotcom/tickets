import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { relativeToProject } from "#scripts/path.ts";
import { projectRoot } from "#scripts/project-root.ts";
import {
  isFeaturePath,
  isSpecPath,
  SPEC_REPORT_DIR,
  SPEC_SUPPORT_GLOBS,
} from "#scripts/specs/paths.ts";

describe("Cucumber paths", () => {
  test("recognises project-relative and absolute spec paths", () => {
    expect(isSpecPath("specs")).toBe(true);
    expect(isSpecPath("specs/payments")).toBe(true);
    expect(isSpecPath(`${projectRoot}/specs/payments`)).toBe(true);
    expect(isSpecPath("test/specs/steps")).toBe(false);
  });

  test("recognises Feature paths with mixed separators", () => {
    expect(isFeaturePath("specs\\payments/example.feature")).toBe(true);
    expect(isFeaturePath("specs/payments/example.feature.md")).toBe(false);
  });
});

/** The folder a support glob looks inside. */
const folderOf = (glob: string): string =>
  join(projectRoot, glob.slice(0, glob.indexOf("/**")));

/** How many TypeScript files live in a folder, however deep. */
const countScripts = async (folder: string): Promise<number> => {
  let found = 0;
  for await (const entry of Deno.readDir(folder)) {
    if (entry.isDirectory)
      found += await countScripts(join(folder, entry.name));
    else if (entry.name.endsWith(".ts")) found += 1;
  }
  return found;
};

describe("where a spec run reads and writes", () => {
  test("keeps its reports in the project's own reports folder", () => {
    expect(relativeToProject(SPEC_REPORT_DIR)).toBe("reports");
  });

  for (const glob of SPEC_SUPPORT_GLOBS) {
    test(`finds files to load for ${glob}`, async () => {
      // A glob pointing at nothing would leave a run with no steps at all, and
      // every scenario would fail for want of anything to do.
      expect(await countScripts(folderOf(glob))).toBeGreaterThan(0);
    });
  }

  test("loads the world before the steps that lean on it", () => {
    const [world, steps] = SPEC_SUPPORT_GLOBS;

    expect(world).toContain("support");
    expect(steps).toContain("steps");
  });
});
