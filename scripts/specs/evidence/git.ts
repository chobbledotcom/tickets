import type { RunCommand } from "#scripts/precommit/git.ts";

const gitOutput = async (
  run: RunCommand,
  cwd: string,
  args: string[],
): Promise<string> => {
  const result = await run(["git", ...args], { cwd });
  if (!result.success) {
    throw new Error(result.stderr.trim());
  }
  return result.stdout.trim();
};

export const defineEvidenceCommit =
  (run: RunCommand): ((cwd: string) => Promise<string>) =>
  async (cwd: string) => {
    const status = await gitOutput(run, cwd, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    if (status) {
      throw new Error(
        `Evidence must be captured from a clean Git worktree:\n${status}`,
      );
    }
    const commit = await gitOutput(run, cwd, ["rev-parse", "HEAD"]);
    if (!/^[a-f0-9]{40}$/.test(commit)) {
      throw new Error(`Git returned an invalid commit: ${commit}`);
    }
    return commit;
  };
