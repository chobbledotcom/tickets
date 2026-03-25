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

/** Extract only failures and errors from deno test output */
const filterTestOutput = (stdout: string, stderr: string): string => {
  const combined = `${stdout}\n${stderr}`;
  const lines = combined.split("\n");
  const output: string[] = [];
  let capturing = false;

  for (const line of lines) {
    // Start capturing at ERRORS or FAILURES sections
    if (/^ ERRORS\s*$/.test(line) || /^ FAILURES\s*$/.test(line)) {
      capturing = true;
    }
    // Always capture the summary line (e.g. "FAILED | 120 passed | 2 failed")
    if (/^(FAILED|ok)\s*\|/.test(line)) {
      capturing = true;
    }
    if (capturing) output.push(line);
  }

  // If no structured sections found, fall back to lines containing FAILED or error info
  if (output.length === 0) {
    for (const line of lines) {
      if (/FAILED|error:|Error:|AssertionError|assert/i.test(line)) {
        output.push(line);
      }
    }
  }

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
