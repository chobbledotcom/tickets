import type { RunCommand } from "#scripts/precommit/git.ts";
import type { CapturedOutput } from "#scripts/process.ts";
import { bindFirst } from "#shared/fp-bind.ts";
import { requireValue } from "#shared/required-value.ts";
import { capturedFail, capturedOk } from "#test-utils/captured-output.ts";

/** What a fake git answers: `base` is the only ref that resolves (null =
 * none), `diff` answers `git diff`, and `show` the two revisions of each
 * changed source. */
export interface FakeGitOptions {
  base?: string | null;
  /** The paths the branch deletes (`--diff-filter=D`); none by default. */
  deleted?: CapturedOutput;
  diff: CapturedOutput;
  /** The sources `HEAD` still holds; none by default. */
  held?: string[];
  /** Contents per `git show <rev>:<path>`; by default each revision differs,
   * so every changed file counts as a real code change. */
  show?: (revPath: string) => CapturedOutput;
}

type Answer = (cmd: string[], opts: FakeGitOptions) => CapturedOutput;

/** `git cat-file -e HEAD:<path>`: succeeds for a source that `HEAD` holds. */
const catFileAnswer: Answer = (cmd, opts) => {
  const target = requireValue(cmd[3], "git cat-file names no path");
  const path = target.replace(/^HEAD:/, "");
  if (opts.held?.includes(path)) return capturedOk();
  return capturedFail(1, "");
};

/** `git rev-parse --verify <ref>`: succeeds for the base ref only. */
const revParseAnswer: Answer = (cmd, opts) => {
  if (cmd.at(-1) === (opts.base ?? null)) return capturedOk();
  return capturedFail(1, "");
};

/** `git show <rev>:<path>`: the scripted text, or a text that differs for
 * every revision. */
const showAnswer: Answer = (cmd, opts) => {
  const revPath = requireValue(cmd[2], "git show names no path");
  if (opts.show) return opts.show(revPath);
  return capturedOk(`const a = "${revPath}";\n`);
};

/** `git diff`: the deleted paths for `--diff-filter=D`, and the changed paths
 * for any other filter. */
const diffAnswer: Answer = (cmd, opts) => {
  if (cmd.includes("--diff-filter=D")) return opts.deleted ?? capturedOk("");
  return opts.diff;
};

const ANSWERS: Record<string, Answer> = {
  "cat-file": catFileAnswer,
  "rev-parse": revParseAnswer,
  show: showAnswer,
};

const runFake = (
  opts: FakeGitOptions,
  cmd: string[],
): Promise<CapturedOutput> => {
  const answer =
    ANSWERS[requireValue(cmd[1], "git names no command")] ?? diffAnswer;
  return Promise.resolve(answer(cmd, opts));
};

/** A fake git for the mutation step. */
export const fakeGit: (opts: FakeGitOptions) => RunCommand = bindFirst(runFake);
