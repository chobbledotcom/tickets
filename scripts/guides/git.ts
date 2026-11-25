/** The commit and cleanliness a guide build records. A dirty tree may still
 * make a video, but it must not replace the committed freshness baseline. */

import { runCommand } from "#scripts/precommit/git.ts";
import { projectRoot } from "#scripts/project-root.ts";

const COMMIT_PATTERN = /^[a-f0-9]{40}$/;

export interface GuideGitState {
  commit: string;
  dirty: boolean;
}

const git = async (args: string[]): Promise<string> => {
  const result = await runCommand(["git", ...args], { cwd: projectRoot });
  if (!result.success) throw new Error(result.stderr.trim());
  return result.stdout.trim();
};

export const guideGitState = async (): Promise<GuideGitState> => {
  const status = await git([
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  const commit = await git(["rev-parse", "HEAD"]);
  if (!COMMIT_PATTERN.test(commit)) {
    throw new Error(`Git returned an invalid commit: ${commit}`);
  }
  return { commit, dirty: status !== "" };
};
