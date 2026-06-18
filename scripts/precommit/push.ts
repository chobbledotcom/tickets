import type { RunCommand } from "./merge-warning.ts";

export interface PushPromptContext {
  branchName: string;
  commitMessage: string;
  originUrl: string;
  unpushedCommits: number;
}

interface PromptToPushOptions {
  confirm: (message: string) => Promise<boolean>;
  isInteractive: () => boolean;
  push: RunCommand;
  run: RunCommand;
}

const runGit = (run: RunCommand, args: string[]) => run(["git", ...args]);

const commandValue = async (
  run: RunCommand,
  args: string[],
): Promise<string | undefined> => {
  const result = await runGit(run, args);
  if (!result.success) return undefined;
  const value = result.stdout.trim();
  return value || undefined;
};

const commandNumber = async (
  run: RunCommand,
  args: string[],
): Promise<number | undefined> => {
  const value = await commandValue(run, args);
  if (!value) return undefined;
  const count = Number(value);
  return Number.isFinite(count) ? count : undefined;
};

const getUnpushedCommitCount = async (
  run: RunCommand,
): Promise<number | undefined> => {
  const upstream = await commandValue(run, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  ]);
  if (upstream) {
    return commandNumber(run, ["rev-list", "--count", `${upstream}..HEAD`]);
  }

  const originMain = await commandValue(run, [
    "rev-parse",
    "--verify",
    "origin/main",
  ]);
  if (originMain) {
    return commandNumber(run, ["rev-list", "--count", "origin/main..HEAD"]);
  }

  return 1;
};

export const getPushPromptContext = async (
  run: RunCommand,
): Promise<PushPromptContext | undefined> => {
  const inWorkTree = await runGit(run, ["rev-parse", "--is-inside-work-tree"]);
  if (!inWorkTree.success) return undefined;

  const status = await runGit(run, ["status", "--porcelain"]);
  if (!status.success || status.stdout.trim()) return undefined;

  const commitMessage = await commandValue(run, ["log", "-1", "--format=%B"]);
  if (!commitMessage) return undefined;

  const unpushedCommits = await getUnpushedCommitCount(run);
  if (!unpushedCommits || unpushedCommits < 1) return undefined;

  const originUrl = await commandValue(run, ["remote", "get-url", "origin"]);
  const branchName = await commandValue(run, [
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ]);
  if (!originUrl || !branchName || branchName === "HEAD") return undefined;

  return {
    branchName,
    commitMessage,
    originUrl,
    unpushedCommits,
  };
};

export const formatPushPrompt = (context: PushPromptContext): string => {
  const subject = context.commitMessage.split(/\r?\n/)[0]!.trim();
  const commitLabel = context.unpushedCommits === 1 ? "commit" : "commits";
  return `Push ${context.unpushedCommits} ${commitLabel} from ${context.branchName} to ${context.originUrl}? ${subject ? `(${subject}) ` : ""}[y/N] `;
};

export const shouldPushFromAnswer = (answer: string): boolean =>
  /^(y|yes)$/i.test(answer.trim());

export const promptToPushCheckedInChanges = async ({
  confirm,
  isInteractive,
  push,
  run,
}: PromptToPushOptions): Promise<boolean> => {
  if (!isInteractive()) return true;

  const context = await getPushPromptContext(run);
  if (!context) return true;

  const shouldPush = await confirm(formatPushPrompt(context));
  if (!shouldPush) return true;

  const result = await push(["git", "push"]);
  return result.success;
};
