import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { Contracts, DumpedMachine } from "#scripts/contract-drift/dump.ts";
import {
  type DriftDeps,
  runContractDrift,
} from "#scripts/contract-drift/run.ts";
import type { CapturedOutput } from "#scripts/process.ts";

const cleanRun: CapturedOutput = {
  code: 0,
  stderr: "",
  stdout: "",
  success: true,
};
const failedRun: CapturedOutput = {
  code: 1,
  stderr: "boom",
  stdout: "",
  success: false,
};

const closed: DumpedMachine = {
  edges: {},
  moneyEvents: [],
  start: "a",
  states: ["a"],
};
const grown: DumpedMachine = { ...closed, states: ["a", "b"] };
const baseDump: Contracts = {
  machines: { m: closed },
};
const headDump: Contracts = { machines: { m: grown } };

interface FakeDeps {
  copyDirs: string[];
  dumpDirs: string[];
  errors: string[];
  gitCalls: string[][];
  logs: string[];
}

const fakeDeps = (
  overrides: {
    addResult?: CapturedOutput;
    base?: Contracts;
    dumpResult?: CapturedOutput;
    head?: Contracts;
    removeResult?: CapturedOutput;
  } = {},
): FakeDeps & { deps: DriftDeps } => {
  const seen: FakeDeps = {
    copyDirs: [],
    dumpDirs: [],
    errors: [],
    gitCalls: [],
    logs: [],
  };
  const deps: DriftDeps = {
    copyDumpModule: (dir) => {
      seen.copyDirs.push(dir);
      return Promise.resolve();
    },
    git: (args) => {
      seen.gitCalls.push([...args]);
      if (args[1] === "add") {
        return Promise.resolve(overrides.addResult ?? cleanRun);
      }
      if (args[1] === "remove") {
        return Promise.resolve(overrides.removeResult ?? cleanRun);
      }
      return Promise.resolve(cleanRun);
    },
    headContracts: () => Promise.resolve(overrides.head ?? headDump),
    makeTempDir: () => Promise.resolve("/tmp/drift-fake"),
    output: {
      log: (line) => seen.logs.push(line),
      logError: (line) => seen.errors.push(line),
    },
    removeTree: () => Promise.resolve(),
    runBaseDump: (dir) => {
      seen.dumpDirs.push(dir);
      if (overrides.dumpResult !== undefined) {
        return Promise.resolve(overrides.dumpResult);
      }
      return Promise.resolve(
        cleanWith(JSON.stringify(overrides.base ?? baseDump)),
      );
    },
  };
  return { ...seen, deps };
};

const cleanWith = (stdout: string): CapturedOutput => ({
  ...cleanRun,
  stdout,
});

describe("contract drift runner", () => {
  test("prints the clean sentence and exits 0", async () => {
    const fake = fakeDeps({ base: baseDump, head: baseDump });
    const code = await runContractDrift("origin/main", fake.deps);
    expect(code).toBe(0);
    expect(fake.logs).toEqual(["No contract drift against origin/main."]);
    expect(fake.gitCalls[0]).toEqual([
      "worktree",
      "add",
      "--detach",
      "/tmp/drift-fake/base",
      "origin/main",
    ]);
    expect(fake.copyDirs).toEqual(["/tmp/drift-fake/base"]);
    expect(fake.dumpDirs).toEqual(["/tmp/drift-fake/base"]);
    expect(fake.gitCalls[1]).toEqual([
      "worktree",
      "remove",
      "--force",
      "/tmp/drift-fake/base",
    ]);
  });

  test("prints the drift and still exits 0", async () => {
    const fake = fakeDeps();
    const code = await runContractDrift("origin/main", fake.deps);
    expect(code).toBe(0);
    expect(fake.logs[0]).toBe(
      "Contract drift against origin/main: 1 change(s)\n\n+ state added: m.b",
    );
  });

  test("exits 1 when the base worktree cannot be created", async () => {
    const fake = fakeDeps({ addResult: failedRun });
    const code = await runContractDrift("origin/main", fake.deps);
    expect(code).toBe(1);
    assertStringIncludes(
      fake.errors[0] ?? "",
      "cannot create the base worktree for origin/main",
    );
    expect(fake.copyDirs).toEqual([]);
    expect(fake.gitCalls).toHaveLength(1);
  });

  test("exits 1 when the base dump does not run", async () => {
    const fake = fakeDeps({ dumpResult: failedRun });
    const code = await runContractDrift("origin/main", fake.deps);
    expect(code).toBe(1);
    assertStringIncludes(
      fake.errors[0] ?? "",
      "the base dump at origin/main did not run",
    );
    expect(fake.gitCalls).toHaveLength(2);
  });

  test("exits 1 when the base dump prints no contracts", async () => {
    for (const stdout of ["not json", "{}"]) {
      const fake = fakeDeps({ dumpResult: cleanWith(stdout) });
      const code = await runContractDrift("origin/main", fake.deps);
      expect(code).toBe(1);
      assertStringIncludes(
        fake.errors[0] ?? "",
        "the base dump at origin/main printed no contracts",
      );
    }
  });

  test("exits 1 when the base worktree cannot be removed", async () => {
    const fake = fakeDeps({ removeResult: failedRun });
    const code = await runContractDrift("origin/main", fake.deps);
    expect(code).toBe(1);
    assertStringIncludes(
      fake.errors[0] ?? "",
      "could not remove the base worktree",
    );
  });
});
