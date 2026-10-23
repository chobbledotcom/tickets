import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { defaultDeps } from "#scripts/check-merged-tree/run.ts";
import { projectRoot } from "#scripts/project-root.ts";

describe("merged-tree check default dependencies", () => {
  test("captures a real git run, defaulting to the checkout root", async () => {
    const deps = defaultDeps();
    const bare = await deps.command("git", ["--version"]);
    expect(bare.success).toBe(true);
    assertStringIncludes(bare.stdout, "git version");
    const rooted = await deps.command(
      "git",
      ["rev-parse", "--show-toplevel"],
      projectRoot,
    );
    expect(rooted.success).toBe(true);
    expect(rooted.stdout.trim()).toBe(projectRoot);
  });

  test("creates and removes a throwaway directory", async () => {
    const deps = defaultDeps();
    const dir = await deps.makeTempDir();
    const stat = await Deno.stat(dir);
    expect(stat.isDirectory).toBe(true);
    await deps.removeTree(dir);
    await expect(Deno.stat(dir)).rejects.toThrow();
  });

  test("copies the pinned stripe-mock binary into the worktree", async () => {
    const deps = defaultDeps();
    const dir = await deps.makeTempDir();
    await deps.copyStripeMock(dir);
    const copied = await Deno.stat(`${dir}/.bin/stripe-mock`);
    expect(copied.isFile).toBe(true);
    await deps.removeTree(dir);
  });

  test("copies nothing when the stripe-mock binary is missing", async () => {
    const deps = defaultDeps("/tmp/no-such-stripe-mock");
    const dir = await deps.makeTempDir();
    await deps.copyStripeMock(dir);
    await expect(Deno.stat(`${dir}/.bin`)).rejects.toThrow();
    await deps.removeTree(dir);
  });

  test("runs a deno task and returns its exit code", async () => {
    const deps = defaultDeps();
    const code = await deps.denoTask("check:copy", projectRoot);
    expect(code).toBe(0);
  });

  test("logs one line of progress", () => {
    const deps = defaultDeps();
    deps.log("merged-tree dependency probe");
  });
});
