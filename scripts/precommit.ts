#!/usr/bin/env -S deno run --allow-all
/**
 * Quiet precommit runner - shows only pass/fail per step, full output on failure.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

const write = (s: string) => Deno.stdout.writeSync(encoder.encode(s));

interface Step {
  cmd: string[];
  filterOutput?: (stdout: string, stderr: string) => string;
  name: string;
  /** Runs after a successful command; return an error message to fail the step */
  verify?: () => Promise<string | null>;
}

/** True when a line starts an ERRORS or FAILURES section or is a summary line */
const isSectionStart = (line: string): boolean =>
  /^ (ERRORS|FAILURES)\s*$/.test(line) || /^(FAILED|ok)\s*\|/.test(line);

/** True when a line contains a failure or error keyword */
const isErrorLine = (line: string): boolean =>
  /FAILED|error:|Error:|AssertionError|assert/i.test(line);

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

/** True when running in CI (the --ci flag or a CI env var is set) */
const isCi = (): boolean =>
  Deno.args.includes("--ci") || Boolean(Deno.env.get("CI"));

/**
 * In CI, `lint` (Biome `check --write`) silently fixes files and exits 0, so a
 * passing lint step would hide unformatted code. After it runs, fail if the
 * working tree changed — the same guard the CI workflow used to inline.
 */
const checkFormatted = async (): Promise<string | null> => {
  const { success } = await new Deno.Command("git", {
    args: ["diff", "--exit-code"],
    stderr: "null",
    stdout: "null",
  }).output();
  return success
    ? null
    : "Code is not formatted/linted. Run 'deno task lint' locally and commit the result.";
};

const getSteps = (ci: boolean): Step[] => {
  return [
    {
      cmd: ["deno", "task", "lint"],
      name: "lint",
      verify: ci ? checkFormatted : undefined,
    },
    { cmd: ["deno", "task", "typecheck"], name: "typecheck" },
    { cmd: ["deno", "task", "cpd"], name: "cpd" },
    { cmd: ["deno", "task", "build:edge"], name: "build:edge" },
    {
      cmd: ["deno", "task", "test:coverage"],
      filterOutput: filterTestOutput,
      name: "test:coverage",
    },
  ];
};

const runStep = async (step: Step): Promise<boolean> => {
  write(`  ${step.name} … `);
  const start = performance.now();

  const cmd = new Deno.Command(step.cmd[0], {
    args: step.cmd.slice(1),
    stderr: "piped",
    stdout: "piped",
  });

  const result = await cmd.output();
  const elapsed = ((performance.now() - start) / 1000).toFixed(1);

  if (result.success) {
    const verifyError = step.verify ? await step.verify() : null;
    if (!verifyError) {
      write(`${green("✓")} ${dim(`${elapsed}s`)}\n`);
      return true;
    }
    write(`${red("✗")} ${dim(`${elapsed}s`)}\n`);
    console.log(verifyError);
    return false;
  }

  write(`${red("✗")} ${dim(`${elapsed}s`)}\n`);
  const stdout = decoder.decode(result.stdout);
  const stderr = decoder.decode(result.stderr);
  const output = step.filterOutput
    ? step.filterOutput(stdout, stderr)
    : [stdout, stderr].filter(Boolean).join("\n");
  if (output) console.log(output);
  return false;
};

const main = async (): Promise<void> => {
  const ci = isCi();
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
