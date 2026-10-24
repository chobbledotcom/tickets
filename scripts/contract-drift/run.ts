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

/** The dump child's whole environment, without DENO_COVERAGE_DIR. A
 * coverage run puts that variable in every child, and a `deno run` child
 * then writes coverage files of its own. The base worktree is gone before
 * the coverage step reads the report, so the fetch of the dumped module
 * fails. The dump is the same code the suite covers in process. `clearEnv`
 * must carry this map, because a child otherwise merges the variable back
 * from this process. */
const dumpChildEnv = (): Record<string, string> => {
  const env = { ...Deno.env.toObject() };
  delete env.DENO_COVERAGE_DIR;
  return env;
};

export interface DriftDeps {
  readonly copyDumpModule: (worktreeDir: string) => Promise<void>;
  readonly git: (args: readonly string[]) => Promise<CapturedOutput>;
  readonly headContracts: () => Promise<Contracts>;
  readonly makeTempDir: () => Promise<string>;
  readonly mergeBase: () => Promise<string>;
  readonly output: CheckOutput;
  readonly removeTree: (path: string) => Promise<void>;
  readonly runBaseDump: (worktreeDir: string) => Promise<CapturedOutput>;
}

/** The drift task's real dependencies. The suite overrides `git` to test
 * the base resolution without a network. */
export const defaultDriftDeps = (
  overrides: { readonly git?: DriftDeps["git"] } = {},
): DriftDeps => {
  const deps: DriftDeps = {
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
    git: overrides.git ?? ((args) => runCommand(["git", ...args])),
    headContracts: currentContracts,
    makeTempDir: () => Deno.makeTempDir({ prefix: "tickets-contract-drift-" }),
    mergeBase: () => mergeBaseWithMain(deps),
    output: consoleOutput,
    removeTree: (path) => Deno.remove(path, { recursive: true }),
    runBaseDump: (worktreeDir) =>
      runCommand(
        ["deno", "run", "--no-check", join(DUMP_DIR, "dump-entry.ts")],
        {
          clearEnv: true,
          cwd: worktreeDir,
          env: dumpChildEnv(),
        },
      ),
  };
  return deps;
};

/** The commit this branch and origin/main share. A one-commit checkout, the
 * CI test job's default, holds no origin/main. This fetches main into the
 * remote-tracking ref, because a fetch without a destination ref leaves no
 * origin/main for the merge base to read. When that does not bring the
 * base and the checkout is shallow, this fetches the full history. A
 * merge-queue checkout holds a merge commit whose parent no main-only
 * fetch reaches, so only the full history brings the base. Throws when the
 * base stays missing. */
const mergeBaseWithMain = async (deps: DriftDeps): Promise<string> => {
  const mergeBase = ["merge-base", "origin/main", "HEAD"] as const;
  let base = await deps.git(mergeBase);
  if (!base.success) {
    await deps.git(["fetch", "origin", "main:refs/remotes/origin/main"]);
    base = await deps.git(mergeBase);
  }
  if (!base.success) {
    const shallow = await deps.git(["rev-parse", "--is-shallow-repository"]);
    if (shallow.stdout.trim() === "true") {
      await deps.git([
        "fetch",
        "--unshallow",
        "origin",
        "+refs/heads/*:refs/remotes/origin/*",
      ]);
      base = await deps.git(mergeBase);
    }
  }
  if (!base.success) {
    throw new Error(
      "This checkout has no origin/main even after a fetch, so the base dump has no older tree to run in. Fetch origin/main or use a full checkout, then run the command again",
    );
  }
  return base.stdout.trim();
};

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
