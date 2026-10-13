/* jscpd:ignore-start -- imports */
import {
  captureOutput,
  denoCommand,
  INHERIT_STDIO,
  removeTree,
} from "#scripts/process.ts";
import { projectRoot } from "#scripts/project-root.ts";
/* jscpd:ignore-end */
import type { ParsedArgs } from "./args.ts";
import {
  checkFailedLine,
  fetchArgs,
  fetchFailedLine,
  labelFor,
  mergeArgs,
  notMergeableHeader,
  resolveBaseArgs,
  resolveHeadArgs,
  successLine,
  unmergedArgs,
  worktreeArgs,
  worktreeFailedLine,
  worktreeRemoveArgs,
} from "./plan.ts";

/** One captured git run. */
export type CommandResult = {
  success: boolean;
  stderr: string;
  stdout: string;
};

/** The outside world the check touches. The tests replace every member. */
export interface MergeTreeDeps {
  /** Run one program with captured output. */
  command(
    program: string,
    args: readonly string[],
    cwd?: string,
  ): Promise<CommandResult>;
  /** Copy the pinned stripe-mock binary into the worktree when one exists. */
  copyStripeMock(worktree: string): Promise<void>;
  /** Run one deno task with inherited output; resolves to its exit code. */
  denoTask(task: string, cwd: string): Promise<number>;
  /** Print one line of progress. */
  log(line: string): void;
  /** Create the throwaway directory that holds the worktree. */
  makeTempDir(): Promise<string>;
  /** Delete a directory tree. */
  removeTree(path: string): Promise<void>;
}

/** The real outside world: git runs captured, deno tasks inherited. The
 *  stripe-mock source is a parameter so tests can name a missing binary. */
export const defaultDeps = (
  stripeMockSource = `${projectRoot}/.bin/stripe-mock`,
): MergeTreeDeps => ({
  command: async (program, args, cwd) => {
    const captured = await captureOutput(
      new Deno.Command(program, {
        args: [...args],
        cwd: cwd ?? projectRoot,
        stderr: "piped",
        stdin: "null",
        stdout: "piped",
      }),
    );
    return {
      stderr: captured.stderr,
      stdout: captured.stdout,
      success: captured.success,
    };
  },
  copyStripeMock: async (worktree) => {
    const stat = await Deno.stat(stripeMockSource).catch(() => undefined);
    if (stat === undefined || !stat.isFile) return;
    await Deno.mkdir(`${worktree}/.bin`, { recursive: true });
    await Deno.copyFile(stripeMockSource, `${worktree}/.bin/stripe-mock`);
  },
  denoTask: async (task, cwd) => {
    const status = await denoCommand(["task", task], {
      cwd,
      ...INHERIT_STDIO,
    }).output();
    return status.code;
  },
  log: (line) => console.log(line),
  makeTempDir: () => Deno.makeTempDir({ prefix: "merged-tree-" }),
  removeTree: (path) => removeTree(path),
});

/** The two tasks that decide the merged tree, in fail-fast order. */
const TREE_TASKS = ["typecheck", "test"] as const;

/** Trial-merge the head into the worktree. Returns the exit code 1 when the
 *  merge conflicts, or undefined when the merge went clean. */
const trialMerge = async (
  deps: MergeTreeDeps,
  label: string,
  base: string,
  headSha: string,
  tempDir: string,
): Promise<number | undefined> => {
  const merged = await deps.command("git", mergeArgs(headSha), tempDir);
  if (merged.success) return;
  deps.log(notMergeableHeader(label, base));
  const detail = merged.stderr.trim();
  if (detail.length > 0) deps.log(detail);
  const paths = (await deps.command("git", unmergedArgs(), tempDir)).stdout
    .split("\n")
    .map((one) => one.trim())
    .filter((one) => one.length > 0);
  for (const path of paths) deps.log(`  conflicted: ${path}`);
  return 1;
};

/** Run the tree tasks on the merged tree. Returns the exit code 2 when one
 *  fails, or undefined when all pass. */
const runTreeTasks = async (
  deps: MergeTreeDeps,
  label: string,
  base: string,
  tempDir: string,
): Promise<number | undefined> => {
  for (const task of TREE_TASKS) {
    deps.log(`running ${task} on the merged tree`);
    if ((await deps.denoTask(task, tempDir)) !== 0) {
      deps.log(checkFailedLine(label, base, task));
      return 2;
    }
  }
  return;
};

/** Remove the worktree and its throwaway directory. */
const cleanup = async (
  deps: MergeTreeDeps,
  tempDir: string | undefined,
  added: boolean,
): Promise<void> => {
  if (tempDir === undefined) return;
  if (added) {
    const removed = await deps.command("git", worktreeRemoveArgs(tempDir));
    if (!removed.success) {
      deps.log(
        `warning: could not remove the worktree at ${tempDir}. Run: git worktree prune`,
      );
    }
  }
  // worktree remove already deleted the directory, so a NotFound here is
  // the expected leftover of a successful removal.
  await deps.removeTree(tempDir).catch(() => undefined);
};

/** Run the check: fetch, trial-merge the head into a throwaway worktree at
 *  the base, run the tree tasks there, and clean the worktree up. Returns the
 *  process exit code: 0 pass, 1 the head does not merge cleanly, 2 a merged-
 *  tree task fails, 3 the inputs name no refs on origin. */
export const runMergedTreeCheck = async (
  parsed: ParsedArgs,
  deps: MergeTreeDeps,
): Promise<number> => {
  const label = labelFor(parsed.head);
  let tempDir: string | undefined;
  let added = false;
  try {
    const fetched = await deps.command(
      "git",
      fetchArgs(parsed.head, parsed.base),
    );
    if (!fetched.success) {
      deps.log(fetchFailedLine(label, parsed.base));
      deps.log(fetched.stderr.trim());
      return 3;
    }
    const headSha = (
      await deps.command("git", resolveHeadArgs(parsed.head))
    ).stdout.trim();
    const baseSha = (
      await deps.command("git", resolveBaseArgs(parsed.base))
    ).stdout.trim();
    tempDir = await deps.makeTempDir();
    const created = await deps.command("git", worktreeArgs(tempDir, baseSha));
    if (!created.success) {
      deps.log(worktreeFailedLine(label, parsed.base));
      deps.log(created.stderr.trim());
      return 3;
    }
    added = true;
    await deps.copyStripeMock(tempDir);
    const mergeResult = await trialMerge(
      deps,
      label,
      parsed.base,
      headSha,
      tempDir,
    );
    if (mergeResult !== undefined) return mergeResult;
    const taskResult = await runTreeTasks(deps, label, parsed.base, tempDir);
    if (taskResult !== undefined) return taskResult;
    deps.log(successLine(label, parsed.base));
    return 0;
  } finally {
    await cleanup(deps, tempDir, added);
  }
};
