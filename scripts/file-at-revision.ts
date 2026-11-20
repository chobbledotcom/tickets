import { type RunCommand, runGit } from "#scripts/precommit/git.ts";

/** The text of `path` at `revision`, or undefined when the revision does not
 * hold the file. A missing path is not an error: `git ls-tree` exits 0 with
 * an empty listing, and its exit codes do not depend on the git locale. A
 * probe or read failure must surface, because a ratchet would otherwise read
 * an empty base and reject unchanged entries as added. */
export const fileAtRevision = async (
  run: RunCommand,
  revision: string,
  path: string,
): Promise<string | undefined> => {
  const tree = await runGit(run, ["ls-tree", revision, "--", path]);
  if (tree.code !== 0) {
    throw new Error(
      `git ls-tree ${revision} -- ${path} failed: ${tree.stderr.trim()}`,
    );
  }
  if (tree.stdout === "") return;
  const show = await runGit(run, ["show", `${revision}:${path}`]);
  if (show.code !== 0) {
    throw new Error(
      `git show ${revision}:${path} failed: ${show.stderr.trim()}`,
    );
  }
  return show.stdout;
};
