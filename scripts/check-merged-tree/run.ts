/* jscpd:ignore-start -- imports */

import { removeIfPresent } from "#scripts/cleanup.ts";
import {
  captureOutput,
  denoCommand,
  INHERIT_STDIO,
  removeTree,
} from "#scripts/process.ts";
import { projectRoot } from "#scripts/project-root.ts";
/* jscpd:ignore-end */
import { errorMessage } from "#shared/error-message.ts";
import type { ParsedArgs } from "./args.ts";
import {
  checkFailedLine,
  cleanupFailedLine,
  fetchArgs,
  fetchFailedLine,
  labelFor,
  mergeArgs,
  notMergeableHeader,
  resolveBaseArgs,
  resolveFailedLine,
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

/** A rejection as a failed command result, for catch paths. */
const failedResult = (error: unknown): CommandResult => ({
  stderr: errorMessage(error),
  stdout: "",
  success: false,
});

/** Remove the worktree and its throwaway directory. Both attempts run
 *  independently and every failure is collected, so one attempt cannot hide
 *  another. Returns false when any attempt left state behind. */
const cleanup = async (
  deps: MergeTreeDeps,
  tempDir: string | undefined,
  added: boolean,
): Promise<boolean> => {
  if (tempDir === undefined) return true;
  const failures: string[] = [];
  if (added) {
    const removed = await deps
      .command("git", worktreeRemoveArgs(tempDir))
      .catch(failedResult);
    if (!removed.success) {
      const detail = removed.stderr.trim();
      failures.push(
        `could not remove the worktree at ${tempDir}${detail.length > 0 ? `: ${detail}` : ""}. Run: git worktree prune`,
      );
    }
  }
  // worktree remove already deleted the directory, so a NotFound here is
  // the expected leftover of a successful removal.
  await removeIfPresent(tempDir, deps.removeTree).catch((error: unknown) =>
    failures.push(
      `could not remove the throwaway directory at ${tempDir}: ${errorMessage(error)}`,
    ),
  );
  for (const failure of failures) deps.log(`warning: ${failure}`);
  return failures.length === 0;
};

/** Resolve one ref to its commit. Returns undefined, with the diagnostic
 *  logged, when the ref does not name a commit on origin. */
const resolveSha = async (
  deps: MergeTreeDeps,
  label: string,
  base: string,
  args: readonly string[],
): Promise<string | undefined> => {
  const resolved = await deps.command("git", args);
  if (!resolved.success) {
    deps.log(resolveFailedLine(label, base));
    deps.log(resolved.stderr.trim());
    return;
  }
  return resolved.stdout.trim();
};

/** Resolve the fetched head and the origin base. Returns undefined, with the
 *  diagnostic logged, when either ref does not name a commit on origin. */
const resolveShas = async (
  deps: MergeTreeDeps,
  label: string,
  base: string,
): Promise<{ baseSha: string; headSha: string } | undefined> => {
  const headSha = await resolveSha(deps, label, base, resolveHeadArgs());
  if (headSha === undefined) return;
  const baseSha = await resolveSha(deps, label, base, resolveBaseArgs(base));
  if (baseSha === undefined) return;
  return { baseSha, headSha };
};

/** Run the check: fetch, trial-merge the head into a throwaway worktree at
 *  the base, run the tree tasks there, and clean the worktree up. Returns the
 *  process exit code: 0 pass, 1 the head does not merge cleanly, 2 a merged-
 *  tree task fails or the cleanup left state behind, 3 the inputs name no
 *  refs on origin. */
export const runMergedTreeCheck = async (
  parsed: ParsedArgs,
  deps: MergeTreeDeps,
): Promise<number> => {
  const label = labelFor(parsed.head);
  let tempDir: string | undefined;
  let added = false;
  /** Clean up, then hold back a pass while the cleanup left state behind. */
  const finish = async (verdict: number): Promise<number> => {
    const cleaned = await cleanup(deps, tempDir, added);
    tempDir = undefined;
    if (!cleaned) {
      deps.log(cleanupFailedLine());
      return 2;
    }
    if (verdict === 0) deps.log(successLine(label, parsed.base));
    return verdict;
  };
  try {
    const fetched = await deps.command(
      "git",
      fetchArgs(parsed.head, parsed.base),
    );
    if (!fetched.success) {
      deps.log(fetchFailedLine(label, parsed.base));
      deps.log(fetched.stderr.trim());
      // Awaited so the finally below sees the post-cleanup state.
      return await finish(3);
    }
    const resolved = await resolveShas(deps, label, parsed.base);
    if (resolved === undefined) return await finish(3);
    tempDir = await deps.makeTempDir();
    const created = await deps.command(
      "git",
      worktreeArgs(tempDir, resolved.baseSha),
    );
    if (!created.success) {
      deps.log(worktreeFailedLine(label, parsed.base));
      deps.log(created.stderr.trim());
      return await finish(3);
    }
    added = true;
    await deps.copyStripeMock(tempDir);
    const mergeResult = await trialMerge(
      deps,
      label,
      parsed.base,
      resolved.headSha,
      tempDir,
    );
    if (mergeResult !== undefined) return await finish(mergeResult);
    const taskResult = await runTreeTasks(deps, label, parsed.base, tempDir);
    if (taskResult !== undefined) return await finish(taskResult);
    return await finish(0);
  } finally {
    // The verdict paths clean up through finish; this catches a thrown
    // error, and cleanup no longer throws, so it cannot mask the original.
    if (tempDir !== undefined) await cleanup(deps, tempDir, added);
  }
};
