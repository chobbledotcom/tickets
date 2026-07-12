#!/usr/bin/env -S deno run --allow-run
/**
 * Count the changed lines of a branch's diff, split by area (src / test / other)
 * and by whether the line is real code or just an import / comment / blank.
 * The classifying and formatting live in ./diff-code-lines-lib.ts; this shell
 * only runs `git diff` and prints.
 *
 * Usage:
 *   deno run --allow-run scripts/diff-code-lines.ts [baseRef]
 *
 * `baseRef` defaults to `origin/main`; the diff is `baseRef...HEAD` (the
 * branch's own changes since it forked, ignoring later commits on the base).
 */

import { formatReport, tallyDiff } from "./diff-code-lines-lib.ts";
import { runCommand } from "./precommit/git.ts";

const runGitDiff = async (base: string): Promise<string> => {
  // --unified=0: only changed lines, no surrounding context to misclassify.
  const result = await runCommand([
    "git",
    "diff",
    "--unified=0",
    `${base}...HEAD`,
  ]);
  if (!result.success) {
    throw new Error(`git diff failed: ${result.stderr}`);
  }
  return result.stdout;
};

const base = Deno.args[0] ?? "origin/main";
console.log(formatReport(tallyDiff(await runGitDiff(base))));
