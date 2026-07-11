import {
  commandValue,
  isInsideWorkTree,
  type RunCommand,
  runGit,
} from "./git.ts";

export const parseMergeTreeConflictedPaths = (stdout: string): string[] => {
  const lines = stdout.split(/\r?\n/);
  const paths: string[] = [];

  for (const line of lines.slice(1)) {
    if (line === "") break;
    paths.push(line);
  }

  return Array.from(new Set(paths));
};

export const getMergeConflictWarning = async (
  run: RunCommand,
): Promise<string | undefined> => {
  if (!(await isInsideWorkTree(run))) return;

  const originUrl = await commandValue(run, ["remote", "get-url", "origin"]);
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
};
