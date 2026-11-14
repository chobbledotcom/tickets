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

/** A reader of the paths that one git command lists for a revision, one on
 * each line. A failed command must surface, because an empty list reads as
 * "no path". */
const pathLister =
  (...command: string[]) =>
  async (run: RunCommand, revision: string): Promise<string[]> => {
    const args = [...command, revision];
    const listing = await runGit(run, args);
    if (listing.code !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${listing.stderr.trim()}`);
    }
    return listing.stdout.split("\n").filter((path) => path !== "");
  };

/** Every path `revision` holds, in git's order. A caller that matches a file
 * by name reads a file the revision holds at a path it does not know. */
export const pathsAtRevision = pathLister("ls-tree", "-r", "--name-only");

/** Every tracked path that differs between `revision` and the working tree. */
export const pathsChangedSince = pathLister("diff", "--name-only");
