/** The IO shell of `deno task contract:diff`: dump the head's contracts
 * here, dump the base's contracts inside a throwaway worktree (this folder
 * is copied in, because the base tree does not carry this script), diff
 * the two, and print the semantic changes.
 *
 * Exit codes: 0 the report printed, drift or not, 1 a step failed. */

import { join } from "@std/path";
import * as v from "valibot";
import { type CheckOutput, consoleOutput } from "#scripts/check-report.ts";
import { runCommand } from "#scripts/precommit/git.ts";
import type { CapturedOutput } from "#scripts/process.ts";
import { projectRoot } from "#scripts/project-root.ts";
import { formatDrift } from "./diff.ts";
import { type Contracts, ContractsSchema, currentContracts } from "./dump.ts";

const DUMP_DIR = join("scripts", "contract-drift");
const DUMP_FILES = ["dump.ts", "dump-entry.ts"] as const;
const WORKTREE_SUBDIR = "base";
export interface DriftDeps {
  readonly copyDumpModule: (worktreeDir: string) => Promise<void>;
  readonly git: (args: readonly string[]) => Promise<CapturedOutput>;
  readonly headContracts: () => Promise<Contracts>;
  readonly makeTempDir: () => Promise<string>;
  readonly output: CheckOutput;
  readonly removeTree: (path: string) => Promise<void>;
  readonly runBaseDump: (worktreeDir: string) => Promise<CapturedOutput>;
}

export const defaultDriftDeps = (): DriftDeps => ({
  copyDumpModule: async (worktreeDir) => {
    const target = join(worktreeDir, DUMP_DIR);
    await Deno.mkdir(target, { recursive: true });
    for (const file of DUMP_FILES) {
      await Deno.copyFile(
        join(projectRoot, DUMP_DIR, file),
        join(target, file),
      );
    }
  },
  git: (args) => runCommand(["git", ...args]),
  headContracts: currentContracts,
  makeTempDir: () => Deno.makeTempDir({ prefix: "tickets-contract-drift-" }),
  output: consoleOutput,
  removeTree: (path) => Deno.remove(path, { recursive: true }),
  runBaseDump: (worktreeDir) =>
    runCommand(["deno", "run", "--no-check", join(DUMP_DIR, "dump-entry.ts")], {
      cwd: worktreeDir,
    }),
});

/** Log one failed step and say the run failed. Null is the answer every
 * failing step returns. */
const failed = (deps: DriftDeps, message: string): null => {
  deps.output.logError(`CONTRACT DRIFT FAILED: ${message}`);
  return null;
};

/** Parse the base dump's JSON, or null when it is not the dump's shape.
 * The dump prints it, so anything else means the dump did not run. */
const parseContracts = (text: string): Contracts | null => {
  try {
    const result = v.safeParse(ContractsSchema, JSON.parse(text));
    return result.success ? result.output : null;
  } catch {
    return null;
  }
};

/** Copy the dump module in and run it inside the worktree. Returns null,
 * with the failure already logged, when a step fails. */
const dumpBase = async (
  deps: DriftDeps,
  baseRef: string,
  worktreePath: string,
): Promise<Contracts | null> => {
  await deps.copyDumpModule(worktreePath);
  const dump = await deps.runBaseDump(worktreePath);
  if (!dump.success) {
    return failed(
      deps,
      `the base dump at ${baseRef} did not run\n${dump.stderr.trim()}`,
    );
  }
  const contracts = parseContracts(dump.stdout);
  if (contracts === null) {
    return failed(deps, `the base dump at ${baseRef} printed no contracts`);
  }
  return contracts;
};

/** The base's contracts, or null with the failure already logged. Null is
 * expected: every failing step below has its message and its exit path. */
const baseContractsOrNull = async (
  deps: DriftDeps,
  baseRef: string,
): Promise<Contracts | null> => {
  const tempDir = await deps.makeTempDir();
  const worktreePath = join(tempDir, WORKTREE_SUBDIR);
  const added = await deps.git([
    "worktree",
    "add",
    "--detach",
    worktreePath,
    baseRef,
  ]);
  if (!added.success) {
    await deps.removeTree(tempDir);
    return failed(
      deps,
      `cannot create the base worktree for ${baseRef}\n${added.stderr.trim()}`,
    );
  }
  const contracts = await dumpBase(deps, baseRef, worktreePath);
  const removed = await deps.git([
    "worktree",
    "remove",
    "--force",
    worktreePath,
  ]);
  await deps.removeTree(tempDir);
  if (!removed.success) {
    return failed(
      deps,
      `could not remove the base worktree\n${removed.stderr.trim()}`,
    );
  }
  return contracts;
};

/** Run the drift report. Returns the process exit code. */
export const runContractDrift = async (
  baseRef: string,
  deps: DriftDeps,
): Promise<number> => {
  const head = await deps.headContracts();
  const base = await baseContractsOrNull(deps, baseRef);
  if (base === null) return 1;
  deps.output.log(formatDrift(base, head, baseRef));
  return 0;
};
