import type { CapturedOutput } from "#scripts/process.ts";

/** One git command's answer in a stub map. */
export type GitStubAnswer = {
  code: number;
  stderr?: string;
  stdout: string;
};

/** A RunCommand stub that answers a fixed map of git invocations. */
export const stubRun =
  (answers: Record<string, GitStubAnswer>) =>
  (cmd: string[]): Promise<CapturedOutput> => {
    const key = cmd.join(" ");
    const answer = answers[key];
    if (!answer) return Promise.reject(new Error(`unexpected command: ${key}`));
    return Promise.resolve({
      stderr: "",
      ...answer,
      success: answer.code === 0,
    });
  };

/** The `git show` command a stub answers for `path` at `revision`. */
export const gitShow = (revision: string, path: string): string =>
  `git show ${revision}:${path}`;

/** The `git ls-tree` command a stub answers for `path` at `revision`. */
export const lsTree = (revision: string, path: string): string =>
  `git ls-tree ${revision} -- ${path}`;

/** The answer a stub gives when `path` exists at the revision. */
export const holds = (path: string): GitStubAnswer => ({
  code: 0,
  stdout: `100644 blob abc123\t${path}\n`,
});
