import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { ContractsSchema } from "#scripts/contract-drift/dump.ts";
import { defaultDriftDeps } from "#scripts/contract-drift/run.ts";
import { projectRoot } from "#scripts/project-root.ts";

describe("contract drift default dependencies", () => {
  test("captures a real git run", async () => {
    const deps = defaultDriftDeps();
    const result = await deps.git(["--version"]);
    expect(result.success).toBe(true);
    expect(result.stdout).toContain("git version");
  });

  test("copies the dump module into a fresh directory", async () => {
    const deps = defaultDriftDeps();
    const dir = await deps.makeTempDir();
    await deps.copyDumpModule(dir);
    for (const file of ["dump.ts", "dump-entry.ts"]) {
      const copied = await Deno.stat(`${dir}/scripts/contract-drift/${file}`);
      expect(copied.isFile).toBe(true);
    }
    await deps.removeTree(dir);
    await expect(Deno.stat(dir)).rejects.toThrow();
  });

  test("runs the real dump entry and prints contracts", async () => {
    const deps = defaultDriftDeps();
    const dump = await deps.runBaseDump(projectRoot);
    expect(dump.success).toBe(true);
    const parsed = v.safeParse(ContractsSchema, JSON.parse(dump.stdout));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Object.keys(parsed.output.machines)).toHaveLength(5);
    }
  });

  test("dumps the head's contracts in process", async () => {
    const deps = defaultDriftDeps();
    const head = await deps.headContracts();
    expect(Object.keys(head.machines)).toHaveLength(5);
  });
});
