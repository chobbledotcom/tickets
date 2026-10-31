/** The git command lines the merged-tree check runs, and the verdict lines it
 *  prints. Pure data: the runner in run.ts executes these in order. */
import type { ParsedArgs } from "./args.ts";

type Head = ParsedArgs["head"];

/** Fetch what the head form needs plus the base, in one call. The head is
 *  named first, so FETCH_HEAD resolves to it: the pull request head ref, or
 *  the named branch on origin. */
export const fetchArgs = (head: Head, base: string): string[] =>
  head.kind === "pr"
    ? ["fetch", "origin", `pull/${head.number}/head`, base]
    : ["fetch", "origin", `refs/heads/${head.name}`, base];

/** The head commit: the first FETCH_HEAD entry, which names the fetched head
 *  for either form. The checkout's own branches and tags are never consulted. */
export const resolveHeadArgs = (): string[] => ["rev-parse", "FETCH_HEAD"];

/** The base commit on origin. */
export const resolveBaseArgs = (base: string): string[] => [
  "rev-parse",
  `origin/${base}`,
];

/** Detach a throwaway worktree at the base commit. */
export const worktreeArgs = (path: string, baseSha: string): string[] => [
  "worktree",
  "add",
  "--detach",
  path,
  baseSha,
];

/** One git command line that appends a single subject argument. */
const gitArgs =
  (command: string, ...flags: string[]) =>
  (subject: string): string[] => [command, ...flags, subject];

/** The trial merge: no commit and no fast-forward, so a conflict stops here. */
export const mergeArgs = gitArgs("merge", "--no-commit", "--no-ff");

/** The paths the trial merge left conflicted. */
export const unmergedArgs = (): string[] => [
  "diff",
  "--name-only",
  "--diff-filter=U",
];

/** Remove the throwaway worktree and its recorded state. */
export const worktreeRemoveArgs = gitArgs("worktree", "remove", "--force");

/** The head as the verdict lines print it. */
export const labelFor = (head: Head): string =>
  head.kind === "pr" ? `PR #${head.number}` : head.name;

/** One verdict line: the shared prefix plus the caller's wording. The wording
 * keeps `{label}` and `{base}` where the head and base names go. One pass, so
 * a name that itself contains a marker is inserted as it is. */
const verdictLine =
  (wording: string) =>
  (label: string, base: string): string =>
    `MERGED-TREE CHECK ${wording.replace(/\{label\}|\{base\}/g, (marker) =>
      marker === "{label}" ? label : base,
    )}`;

export const successLine = verdictLine("PASSED: {label} merges into {base}");

export const notMergeableHeader = verdictLine(
  "FAILED: {label} does not merge cleanly into {base}",
);

export const checkFailedLine = (
  label: string,
  base: string,
  task: string,
): string =>
  `MERGED-TREE CHECK FAILED: ${label} merges into ${base} but ${task} fails on the merged tree`;

export const fetchFailedLine = verdictLine(
  "FAILED: cannot fetch {label} or origin/{base}",
);

export const resolveFailedLine = verdictLine(
  "FAILED: cannot resolve {label} against origin/{base}",
);

export const worktreeFailedLine = verdictLine(
  "FAILED: cannot create the trial worktree for {label} into {base}",
);

export const cleanupFailedLine = (): string =>
  "MERGED-TREE CHECK FAILED: the trial worktree could not be cleaned up";
