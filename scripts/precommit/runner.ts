import { readStream } from "#scripts/stream-lines.ts";
import { precommitWorkerCount } from "#scripts/workers.ts";
import { bold, dim, green, red, yellow } from "./colors.ts";
import { runCommand, runInteractiveCommand, splitCommand } from "./git.ts";
import { acquirePrecommitLock } from "./lock.ts";
import { getMergeConflictWarning } from "./merge-warning.ts";
import { promptToPushCheckedInChanges, shouldPushFromAnswer } from "./push.ts";
import { getSteps, type Step } from "./steps.ts";
import {
  canPrompt,
  canShowProgress,
  currentTerminalState,
} from "./terminal.ts";
import { write } from "./write.ts";

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

export const main = async (): Promise<void> => {
  const ci = isCi();
  if (ci && !Deno.env.get("CI")) Deno.env.set("CI", "1");
  // Cap test parallelism for the run. CI uses every thread; a local git hook
  // uses (threads / 2) - 1 so the editor and foreground work keep headroom.
  // An explicit DENO_JOBS always wins — only set a default when unset.
  if (!Deno.env.get("DENO_JOBS")) {
    Deno.env.set(
      "DENO_JOBS",
      String(precommitWorkerCount(navigator.hardwareConcurrency, ci)),
    );
  }
  console.log(bold(ci ? "precommit (ci)" : "precommit"));
  await warnAboutMergeConflicts();

  // In CI, runs are isolated, so skip the lock. Locally, wait for any other
  // tickets precommit run (even from a different checkout) to finish before
  // starting — two runs at once just contention-saturate the machine.
  const run: () => Promise<void> = ci
    ? runStepsAndPush
    : () => withLock(runStepsAndPush);
  await run();
};

/**
 * Acquire the cross-instance precommit lock, run `task`, and release the lock
 * on completion — success or failure. While waiting, tell the user which
 * process holds the lock and how long we have waited, and that they may want
 * to kill this waiter and run a more targeted check instead.
 */
const withLock = async (task: () => Promise<void>): Promise<void> => {
  const lock = await acquirePrecommitLock(({ holderPid, waitedMs }) => {
    const seconds = Math.round(waitedMs / 1000);
    const hint =
      seconds === 0
        ? `Another tickets precommit run is in progress (PID ${holderPid}). Waiting for it to finish.`
        : `Still waiting for PID ${holderPid} (${seconds}s). You can kill this process and run a more targeted test with \`deno task test:files <path>\`.`;
    console.log(yellow(hint));
  });
  if (!lock.acquired) {
    console.log(
      red(
        "Another tickets precommit run holds the lock and waiting was skipped.",
      ),
    );
    Deno.exit(1);
  }
  try {
    await task();
  } finally {
    lock.release();
  }
};

const runStepsAndPush = async (): Promise<void> => {
  const steps = getSteps();
  for (const step of steps) {
    const passed = await runStep(step);
    if (!passed) {
      console.log(`\n${red("precommit failed")} at ${step.name}`);
      Deno.exit(1);
    }
  }

  console.log(`\n${green("precommit passed")}`);
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
