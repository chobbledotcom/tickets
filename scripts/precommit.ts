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
  name: string;
  cmd: string[];
  filterOutput?: (stdout: string, stderr: string) => string;
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

const steps: Step[] = [
  { name: "biome:fix", cmd: ["deno", "task", "biome:fix"] },
  { name: "typecheck", cmd: ["deno", "task", "typecheck"] },
  { name: "lint", cmd: ["deno", "task", "lint"] },
  { name: "cpd", cmd: ["deno", "task", "cpd"] },
  { name: "build:edge", cmd: ["deno", "task", "build:edge"] },
  {
    name: "test:coverage",
    cmd: ["deno", "task", "test:coverage"],
    filterOutput: filterTestOutput,
  },
];

const runStep = async (step: Step): Promise<boolean> => {
  write(`  ${step.name} … `);
  const start = performance.now();

  const cmd = new Deno.Command(step.cmd[0], {
    args: step.cmd.slice(1),
    stdout: "piped",
    stderr: "piped",
  });

  const result = await cmd.output();
  const elapsed = ((performance.now() - start) / 1000).toFixed(1);

  if (result.success) {
    write(`${green("✓")} ${dim(`${elapsed}s`)}\n`);
    return true;
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
  console.log(bold("precommit"));

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
