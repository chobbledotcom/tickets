import {
  commandValue,
  type RunCommand,
  runGit,
  withinWorkTree,
} from "./git.ts";

/** The `origin` remote's URL, or undefined when there is no origin. */
export const getOriginUrl = (run: RunCommand): Promise<string | undefined> =>
  commandValue(run, ["remote", "get-url", "origin"]);

export const parseMergeTreeConflictedPaths = (stdout: string): string[] => {
  const lines = stdout.split(/\r?\n/);
  const paths: string[] = [];

  for (const line of lines.slice(1)) {
    if (line === "") break;
    paths.push(line);
  }

  return Array.from(new Set(paths));
};

export const getMergeConflictWarning = (
  run: RunCommand,
): Promise<string | undefined> =>
  withinWorkTree(run, async () => {
    const originUrl = await getOriginUrl(run);
    const head = await commandValue(run, ["rev-parse", "--verify", "HEAD"]);
    const originMain = await commandValue(run, [
      "rev-parse",
      "--verify",
      "origin/main",
    ]);
    const mergeBase = await commandValue(run, [
      "merge-base",
      "HEAD",
      "origin/main",
    ]);
    const candidateTree = await commandValue(run, ["write-tree"]);
    if (!originUrl || !head || !originMain || !mergeBase || !candidateTree) {
      return;
    }

    const result = await runGit(run, [
      "merge-tree",
      "--write-tree",
      "--name-only",
      "--merge-base",
      mergeBase,
      candidateTree,
      "origin/main",
    ]);
    if (result.code !== 1) return;

    const conflictCount = parseMergeTreeConflictedPaths(result.stdout).length;
    if (conflictCount === 0) return;

    return `Heads up - this branch has ${conflictCount} merge conflicts against ${originUrl}`;
  });
