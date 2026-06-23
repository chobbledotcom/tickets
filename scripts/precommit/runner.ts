import { bold, dim, green, red, write, yellow } from "./colors.ts";
import {
  getMergeConflictWarning,
  runCommand,
  runInteractiveCommand,
} from "./merge-warning.ts";
import { promptToPushCheckedInChanges, shouldPushFromAnswer } from "./push.ts";
import { getSteps, type Step } from "./steps.ts";
import {
  canPrompt,
  canShowProgress,
  currentTerminalState,
} from "./terminal.ts";

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

const readStream = async (
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<string> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      text += chunk;
      buffered += chunk;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    }
  } finally {
    const chunk = decoder.decode();
    text += chunk;
    buffered += chunk;
    if (buffered) onLine(buffered);
    reader.releaseLock();
  }

  return text;
};

const runStep = async (step: Step): Promise<boolean> => {
  const prefix = `  ${step.name} … `;
  write(prefix);
  const start = performance.now();
  const [command, ...args] = step.cmd;
  if (!command) throw new Error(`No command configured for ${step.name}`);

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

  if (status.success) {
    write(`${green("✓")} ${dim(`${elapsed}s`)}\n`);
    return true;
  }

  write(`${red("✗")} ${dim(`${elapsed}s`)}\n`);
  const output = step.filterOutput
    ? step.filterOutput(stdout, stderr)
    : [stdout, stderr].filter(Boolean).join("\n");
  if (output) console.log(output);
  return false;
};

export const main = async (): Promise<void> => {
  const ci = isCi();
  if (ci && !Deno.env.get("CI")) Deno.env.set("CI", "1");
  console.log(bold(ci ? "precommit (ci)" : "precommit"));
  await warnAboutMergeConflicts();

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
