import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { projectRoot } from "#scripts/project-root.ts";

/**
 * scripts/ci/deno-install.sh is the one install policy for CI and the
 * container image. --frozen rejects a lockfile that drifted from the config.
 * The --allow-scripts list must name exactly the npm packages whose lifecycle
 * scripts deno.lock records, so a dependency that adds a script-bearing
 * package fails here until the policy names it.
 */

const scriptPath = "scripts/ci/deno-install.sh";

const scriptedPackages = async (): Promise<string[]> => {
  const script = await Deno.readTextFile(join(projectRoot, scriptPath));
  const allow = script.match(/--allow-scripts=([^\s\\]+)/)?.[1] ?? "";
  return allow
    .split(",")
    .map((name) => name.replace(/^npm:/, ""))
    .sort();
};

const lockfileScriptedPackages = async (): Promise<string[]> => {
  const lock = JSON.parse(
    await Deno.readTextFile(join(projectRoot, "deno.lock")),
  ) as {
    npm: Record<string, { scripts?: boolean }>;
  };
  return Object.keys(lock.npm)
    .filter((key) => lock.npm[key]?.scripts === true)
    .map((key) => key.replace(/@[^@]+$/, ""))
    .sort();
};

describe("the shared dependency install policy", () => {
  test("installs with a frozen lockfile", async () => {
    const script = await Deno.readTextFile(join(projectRoot, scriptPath));
    expect(script).toContain("deno install");
    expect(script).toContain("--frozen");
  });

  test("allows lifecycle scripts only for the packages deno.lock records", async () => {
    expect(await scriptedPackages()).toEqual(await lockfileScriptedPackages());
  });
});
