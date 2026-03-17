#!/usr/bin/env -S deno run --allow-all
/**
 * Test runner script that ensures stripe-mock is running before tests
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStaticAssets } from "./build-static-assets.ts";

const STRIPE_MOCK_VERSION = "0.188.0";
const STRIPE_MOCK_PORT = 12111;
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN_DIR = join(projectRoot, ".bin");
const STRIPE_MOCK_PATH = join(BIN_DIR, "stripe-mock");

/** Check if stripe-mock is running */
const isStripeMockRunning = async (): Promise<boolean> => {
  try {
    await fetch(`http://localhost:${STRIPE_MOCK_PORT}/`);
    return true;
  } catch {
    return false;
  }
};

/** Download stripe-mock if needed */
const downloadStripeMock = async (): Promise<void> => {
  try {
    await Deno.stat(STRIPE_MOCK_PATH);
    return;
  } catch {
    // Download needed
  }

  console.log("Downloading stripe-mock...");
  await Deno.mkdir(BIN_DIR, { recursive: true });

  const platform = Deno.build.os === "darwin" ? "darwin" : "linux";
  const arch = Deno.build.arch === "aarch64" ? "arm64" : "amd64";
  const url = `https://github.com/stripe/stripe-mock/releases/download/v${STRIPE_MOCK_VERSION}/stripe-mock_${STRIPE_MOCK_VERSION}_${platform}_${arch}.tar.gz`;

  const curlCmd = new Deno.Command("curl", {
    args: ["-sL", url, "-o", "-"],
    stdout: "piped",
    stderr: "null",
  });
  const curlResult = await curlCmd.output();
  if (!curlResult.success) {
    throw new Error("Failed to download stripe-mock");
  }

  const tarPath = join(BIN_DIR, "stripe-mock.tar.gz");
  await Deno.writeFile(tarPath, curlResult.stdout);

  await new Deno.Command("tar", {
    args: ["-xzf", tarPath, "-C", BIN_DIR],
  }).output();

  await new Deno.Command("chmod", {
    args: ["+x", STRIPE_MOCK_PATH],
  }).output();

  await Deno.remove(tarPath);
  console.log("stripe-mock downloaded");
};

/** Start stripe-mock and return the process */
const startStripeMock = async (): Promise<Deno.ChildProcess | null> => {
  if (await isStripeMockRunning()) {
    console.log("stripe-mock already running on port", STRIPE_MOCK_PORT);
    return null;
  }

  await downloadStripeMock();

  console.log("Starting stripe-mock on port", STRIPE_MOCK_PORT);
  const cmd = new Deno.Command(STRIPE_MOCK_PATH, {
    args: ["-http-port", String(STRIPE_MOCK_PORT)],
    stdout: "null",
    stderr: "null",
  });
  const process = cmd.spawn();

  // Wait for it to be ready
  for (let i = 0; i < 30; i++) {
    if (await isStripeMockRunning()) {
      console.log("stripe-mock started");
      return process;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  throw new Error("stripe-mock failed to start");
};

/** Build the deno test CLI args */
const buildDenoTestArgs = (useCoverage: boolean): string[] => {
  const args = [
    "test",
    "--no-check",
    "--allow-net",
    "--allow-env",
    "--allow-read",
    "--allow-write",
    "--allow-run",
    "--allow-sys",
    "--allow-ffi",
    "--parallel",
  ];
  if (useCoverage) args.push("--coverage=coverage");
  args.push("test/");
  return args;
};

/** Run deno test and return the exit code */
const runTests = async (useCoverage: boolean): Promise<number> => {
  console.log("Running tests...");
  const testCmd = new Deno.Command(Deno.execPath(), {
    args: buildDenoTestArgs(useCoverage),
    cwd: projectRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...Deno.env.toObject(),
      STRIPE_MOCK_HOST: "localhost",
      STRIPE_MOCK_PORT: String(STRIPE_MOCK_PORT),
      ALLOWED_DOMAIN: "localhost",
      DENO_JOBS: Deno.env.get("DENO_JOBS") ?? "3",
    },
  });
  const result = await testCmd.output();
  return result.code;
};

/** Check a coverage metric (lines or branches) in an lcov record */
const checkMetric = (
  record: string,
  hitKey: string,
  foundKey: string,
  file: string,
  label: string,
): string | undefined => {
  const hitMatch = record.match(new RegExp(`${hitKey}:(\\d+)`));
  const foundMatch = record.match(new RegExp(`${foundKey}:(\\d+)`));
  if (!hitMatch || !foundMatch) return undefined;
  const hit = parseInt(hitMatch[1], 10);
  const found = parseInt(foundMatch[1], 10);
  return hit < found ? `${file}: ${hit}/${found} ${label} covered` : undefined;
};

// Files excluded from coverage enforcement
const COVERAGE_EXCLUSIONS = ["src/lib/db/migrations.ts"];

/** Extract the relative file path from an lcov record, or null if excluded */
const extractRecordFile = (record: string): string | null => {
  const sfMatch = record.match(/SF:(.*)/);
  if (!sfMatch) return null;
  const file = sfMatch[1].replace(`${projectRoot}/`, "");
  if (COVERAGE_EXCLUSIONS.some((exclusion) => file.includes(exclusion)))
    return null;
  return file;
};

/** Check both line and branch coverage for a single lcov record */
const checkRecord = (
  record: string,
  file: string,
  lineFailures: string[],
  branchFailures: string[],
): void => {
  const lineFail = checkMetric(record, "LH", "LF", file, "lines");
  if (lineFail) lineFailures.push(lineFail);
  const branchFail = checkMetric(record, "BRH", "BRF", file, "branches");
  if (branchFail) branchFailures.push(branchFail);
};

/** Parse lcov records and return coverage failures */
const findCoverageFailures = (
  lcov: string,
): { lineFailures: string[]; branchFailures: string[] } => {
  const records = lcov.split("end_of_record").filter((r) => r.includes("SF:"));
  if (records.length === 0)
    return { lineFailures: ["No coverage data found"], branchFailures: [] };

  const lineFailures: string[] = [];
  const branchFailures: string[] = [];
  for (const record of records) {
    const file = extractRecordFile(record);
    if (file) checkRecord(record, file, lineFailures, branchFailures);
  }
  return { lineFailures, branchFailures };
};

/** Print a labeled list of failures */
const printFailureCategory = (label: string, failures: string[]): void => {
  if (failures.length === 0) return;
  console.error(`\n${label}:`);
  for (const f of failures) console.error(`  ${f}`);
};

/** Report coverage failures and exit if any */
const reportCoverageFailures = (
  lineFailures: string[],
  branchFailures: string[],
): void => {
  if (lineFailures.length === 0 && branchFailures.length === 0) {
    console.log("\nAll files have 100% line and branch coverage");
    return;
  }
  printFailureCategory("Line coverage is not 100%", lineFailures);
  printFailureCategory("Branch coverage is not 100%", branchFailures);
  console.error("\nTest quality rules:");
  console.error("  - 100% line coverage is required");
  console.error("  - 100% branch coverage is required");
  console.error("  - Test outcomes not implementations");
  console.error("  - Test-only exports are forbidden");
  console.error("  - Tautological tests are forbidden");
  Deno.exit(1);
};

/** Run coverage check: print table, parse lcov, enforce 100% */
const checkCoverage = async (): Promise<void> => {
  console.log("\nChecking coverage...");
  const coverageDir = join(projectRoot, "coverage");

  const tableCmd = new Deno.Command(Deno.execPath(), {
    args: ["coverage", coverageDir],
    cwd: projectRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  await tableCmd.output();

  const lcovCmd = new Deno.Command(Deno.execPath(), {
    args: ["coverage", coverageDir, "--lcov"],
    cwd: projectRoot,
    stdout: "piped",
    stderr: "inherit",
  });
  const lcovResult = await lcovCmd.output();
  const lcov = new TextDecoder().decode(lcovResult.stdout);

  const { lineFailures, branchFailures } = findCoverageFailures(lcov);
  reportCoverageFailures(lineFailures, branchFailures);
};

/** Main: start stripe-mock, run tests, cleanup */
const main = async (): Promise<void> => {
  await buildStaticAssets({ stop: true });
  const stripeMockProcess = await startStripeMock();

  Deno.env.set("STRIPE_MOCK_HOST", "localhost");
  Deno.env.set("STRIPE_MOCK_PORT", String(STRIPE_MOCK_PORT));
  Deno.env.set("ALLOWED_DOMAIN", "localhost");

  const useCoverage = Deno.args.includes("--coverage");
  const exitCode = await runTests(useCoverage);

  if (stripeMockProcess) {
    console.log("Stopping stripe-mock...");
    stripeMockProcess.kill();
  }

  if (exitCode !== 0) Deno.exit(exitCode);
  if (useCoverage) await checkCoverage();
  Deno.exit(0);
};

main();
