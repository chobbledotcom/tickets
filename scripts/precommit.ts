#!/usr/bin/env -S deno run --allow-all
/**
 * Quiet precommit runner - shows only pass/fail per step, full output on failure.
 */

const encoder = new TextEncoder();

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

const write = (s: string) => Deno.stdout.writeSync(encoder.encode(s));

interface Step {
  cmd: string[];
  filterOutput?: (stdout: string, stderr: string) => string;
  progress?: (line: string) => string | undefined;
  name: string;
}

const isInteractive = (): boolean =>
  Deno.stdout.isTerminal() && !Deno.env.get("CI");

/** True when a line starts an ERRORS or FAILURES section or is a summary line */
const isSectionStart = (line: string): boolean =>
  /^ (ERRORS|FAILURES)\s*$/.test(line) ||
  /^::error/.test(line) ||
  /^Coverage failed/.test(line) ||
  /^(FAILED|Failed tests:|fail\b)/.test(line) ||
  /^(Line|Branch) coverage is not 100%:/.test(line) ||
  /^Test quality rules:/.test(line) ||
  /^(FAILED|ok)\s*\|/.test(line);

/** True when a line contains a failure or error keyword */
const isErrorLine = (line: string): boolean =>
  /^::error/.test(line) ||
  /^Coverage failed/.test(line) ||
  /^(FAILED|fail\b|error:|Error:|AssertionError)/.test(line) ||
  /coverage is not 100%/.test(line);

/** Collect lines from the first section-start onward */
const collectFromSections = (lines: string[]): string[] => {
  const output: string[] = [];
  let capturing = false;
  for (const line of lines) {
    if (isSectionStart(line)) capturing = true;
    if (capturing) output.push(line);
  }
  return output;
};

/** Extract only failures and errors from deno test output */
const filterTestOutput = (stdout: string, stderr: string): string => {
  const lines = `${stdout}\n${stderr}`.split("\n");
  const output = collectFromSections(lines);
  if (output.length === 0) return lines.filter(isErrorLine).join("\n").trim();
  return output.join("\n").trim();
};

const testProgressFromLine = (line: string): string | undefined => {
  if (line.trim() === "Running tests...") return "(starting tests)";

  const numbered = line.match(/^(?:ok|fail)\s+\[[^\]]+\]\s+(\d+)\/(\d+)\b/);
  if (numbered?.[1] && numbered[2]) return `(${numbered[1]}/${numbered[2]})`;

  const done = line.match(/^(?:ok|fail)\s+\[\s*(\d+)\s+done\]/);
  if (done?.[1]) return `(${done[1]} done)`;

  if (line.trim() === "Checking coverage...") return "(checking coverage)";
  return undefined;
};

/** True when running in CI (the --ci flag or a CI env var is set) */
const isCi = (): boolean =>
  Deno.args.includes("--ci") || Boolean(Deno.env.get("CI"));

const getSteps = (ci: boolean): Step[] => {
  return [
    // Dev runs the auto-fixing `lint` (Biome `check --write`). CI runs the
    // read-only `lint:ci`, which fails when code *would* be reformatted or has
    // a lint warning — catching unformatted code without modifying the checkout
    // or requiring a clean working tree.
    { cmd: ["deno", "task", ci ? "lint:ci" : "lint"], name: "lint" },
    { cmd: ["deno", "task", "typecheck"], name: "typecheck" },
    { cmd: ["deno", "task", "cpd"], name: "cpd" },
    { cmd: ["deno", "task", "build:edge"], name: "build:edge" },
    {
      cmd: ["deno", "task", "test:coverage"],
      filterOutput: filterTestOutput,
      name: "test:coverage",
      progress: testProgressFromLine,
    },
  ];
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
    if (!step.progress || !isInteractive()) return;
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

const main = async (): Promise<void> => {
  const ci = isCi();
  if (ci && !Deno.env.get("CI")) Deno.env.set("CI", "1");
  console.log(bold(ci ? "precommit (ci)" : "precommit"));

  const steps = getSteps(ci);
  for (const step of steps) {
    const passed = await runStep(step);
    if (!passed) {
      console.log(`\n${red("precommit failed")} at ${step.name}`);
      Deno.exit(1);
    }
  }

  console.log(`\n${green("precommit passed")}`);
};

main();
