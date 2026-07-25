import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "#scripts/lock-file.ts";
import { readStream } from "#scripts/stream-lines.ts";
import { resolveDenoJobs } from "#scripts/workers.ts";
import { bold, dim, green, red, yellow } from "./colors.ts";
import { runCommand, runInteractiveCommand, splitCommand } from "./git.ts";
import { getMergeConflictWarning } from "./merge-warning.ts";
import { promptToPushCheckedInChanges, shouldPushFromAnswer } from "./push.ts";
import { runChecksBeforePush } from "./run-order.ts";
import { getSteps, type Step } from "./steps.ts";
import {
  canPrompt,
  canShowProgress,
  currentTerminalState,
} from "./terminal.ts";
import { write } from "./write.ts";

const PRECOMMIT_LOCK_PATH = join(tmpdir(), "chobble-tickets-precommit.lock");

const withPrecommitLock = (task: () => Promise<void>): Promise<void> =>
  withFileLock(PRECOMMIT_LOCK_PATH, task);

const canPromptNow = (): boolean => canPrompt(currentTerminalState());

const canShowProgressNow = (): boolean =>
  canShowProgress(currentTerminalState());

/** True when running in CI (the --ci flag or a CI env var is set) */
const isCi = (): boolean =>
  Deno.args.includes("--ci") || Boolean(Deno.env.get("CI"));

const warnAboutMergeConflicts = async (): Promise<void> => {
  try {
    const warning = await getMergeConflictWarning(runCommand);
    if (warning) console.warn(yellow(warning));
  } catch {
    // This check is advisory only; never block precommit if Git probing fails.
  }
};

const readPromptLine = async (): Promise<string> => {
  const buffer = new Uint8Array(1024);
  const bytesRead = await Deno.stdin.read(buffer);
  if (bytesRead === null) return "";
  return new TextDecoder().decode(buffer.subarray(0, bytesRead));
};

const confirmPush = async (message: string): Promise<boolean> => {
  write(message);
  return shouldPushFromAnswer(await readPromptLine());
};

const runStep = async (step: Step): Promise<boolean> => {
  const prefix = `  ${step.name} … `;
  write(prefix);
  const start = performance.now();
  const [command, args] = splitCommand(step.cmd, `command for ${step.name}`);

  const cmd = new Deno.Command(command, {
    args,
    stderr: "piped",
    stdout: "piped",
  });

  const child = cmd.spawn();
  let progress = "";
  const updateProgress = (line: string): void => {
    if (!step.progress || !canShowProgressNow()) return;
    const next = step.progress(line);
    if (!next || next === progress) return;
    progress = next;
    write(`\r\x1b[2K${prefix}${progress} `);
  };

  const stdoutTask = readStream(child.stdout, updateProgress);
  const stderrTask = readStream(child.stderr, updateProgress);
  const [status, stdout, stderr] = await Promise.all([
    child.status,
    stdoutTask,
    stderrTask,
  ]);
  const elapsed = ((performance.now() - start) / 1000).toFixed(1);
  if (progress) write(`\r\x1b[2K${prefix}`);
  const success = status.success;
  write(`${success ? green("✓") : red("✗")} ${dim(`${elapsed}s`)}\n`);

  if (!success) {
    const output = step.filterOutput
      ? step.filterOutput(stdout, stderr)
      : [stdout, stderr].filter(Boolean).join("\n");
    if (output) console.log(output);
  }

  if (success && step.summary) {
    const summary = await step.summary(stdout, stderr);
    if (summary) console.log(summary);
  }

  return success;
};

const runSteps = async (): Promise<void> => {
  const steps = getSteps();
  for (const step of steps) {
    const passed = await runStep(step);
    if (!passed) {
      console.log(`\n${red("precommit failed")} at ${step.name}`);
      Deno.exit(1);
    }
  }

  console.log(`\n${green("precommit passed")}`);
};

const pushCheckedInChanges = async (): Promise<void> => {
  const pushSucceeded = await promptToPushCheckedInChanges({
    confirm: confirmPush,
    isInteractive: canPromptNow,
    push: runInteractiveCommand,
    run: runCommand,
  });
  if (!pushSucceeded) {
    console.log(red("git push failed"));
    Deno.exit(1);
  }
};

export const main = async (): Promise<void> => {
  const ci = isCi();
  if (ci && !Deno.env.get("CI")) Deno.env.set("CI", "1");
  // Cap test parallelism for the run. CI uses every thread; a local git hook
  // uses (threads / 2) - 1 so the editor and foreground work keep headroom.
  // A valid explicit DENO_JOBS wins; replace invalid values with the default.
  const jobs = resolveDenoJobs(
    navigator.hardwareConcurrency,
    ci,
    Deno.env.get("DENO_JOBS"),
  );
  Deno.env.set("DENO_JOBS", String(jobs));
  console.log(bold(ci ? "precommit (ci)" : "precommit"));
  await warnAboutMergeConflicts();
  await runChecksBeforePush(
    ci,
    runSteps,
    pushCheckedInChanges,
    withPrecommitLock,
  );
};
