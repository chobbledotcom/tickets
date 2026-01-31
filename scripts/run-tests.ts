#!/usr/bin/env -S deno run --allow-all
/**
 * Test runner script that ensures stripe-mock is running before tests
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

/** Main: start stripe-mock, run tests, cleanup */
const main = async (): Promise<void> => {
  const stripeMockProcess = await startStripeMock();

  // Set environment for tests
  Deno.env.set("STRIPE_MOCK_HOST", "localhost");
  Deno.env.set("STRIPE_MOCK_PORT", String(STRIPE_MOCK_PORT));
  Deno.env.set("ALLOWED_DOMAIN", "localhost");

  // Get test args (pass through any CLI args after --)
  const testArgs = Deno.args;
  const useCoverage = testArgs.includes("--coverage");

  const denoTestArgs = [
    "test",
    "--no-check",
    "--allow-net",
    "--allow-env",
    "--allow-read",
    "--allow-write",
    "--allow-run",
    "--allow-sys",
    "--allow-ffi",
  ];

  if (useCoverage) {
    denoTestArgs.push("--coverage=coverage");
  }

  denoTestArgs.push("test/");

  console.log("Running tests...");
  const testCmd = new Deno.Command(Deno.execPath(), {
    args: denoTestArgs,
    cwd: projectRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...Deno.env.toObject(),
      STRIPE_MOCK_HOST: "localhost",
      STRIPE_MOCK_PORT: String(STRIPE_MOCK_PORT),
      ALLOWED_DOMAIN: "localhost",
    },
  });

  const result = await testCmd.output();

  // Cleanup
  if (stripeMockProcess) {
    console.log("Stopping stripe-mock...");
    stripeMockProcess.kill();
  }

  if (result.code !== 0) {
    Deno.exit(result.code);
  }

  if (useCoverage) {
    console.log("\nChecking coverage...");
    const coverageDir = join(projectRoot, "coverage");

    // Print human-readable table
    const tableCmd = new Deno.Command(Deno.execPath(), {
      args: ["coverage", coverageDir],
      cwd: projectRoot,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await tableCmd.output();

    // Parse stable lcov format for enforcement
    const lcovCmd = new Deno.Command(Deno.execPath(), {
      args: ["coverage", coverageDir, "--lcov"],
      cwd: projectRoot,
      stdout: "piped",
      stderr: "inherit",
    });
    const lcovResult = await lcovCmd.output();
    const lcov = new TextDecoder().decode(lcovResult.stdout);

    // Parse lcov records: enforce 100% line coverage, report branch coverage
    const records = lcov.split("end_of_record").filter((r) => r.includes("SF:"));
    if (records.length === 0) {
      console.error("No coverage data found");
      Deno.exit(1);
    }

    const failures: string[] = [];
    const branchWarnings: string[] = [];

    for (const record of records) {
      const sfMatch = record.match(/SF:(.*)/);
      if (!sfMatch) continue;
      const file = sfMatch[1].replace(projectRoot + "/", "");

      // Line coverage: LH (lines hit) / LF (lines found)
      const lhMatch = record.match(/LH:(\d+)/);
      const lfMatch = record.match(/LF:(\d+)/);
      if (lhMatch && lfMatch) {
        const hit = parseInt(lhMatch[1]);
        const found = parseInt(lfMatch[1]);
        if (hit < found) {
          failures.push(`${file}: ${hit}/${found} lines covered`);
        }
      }

      // Branch coverage: BRH (branches hit) / BRF (branches found) — advisory
      const brhMatch = record.match(/BRH:(\d+)/);
      const brfMatch = record.match(/BRF:(\d+)/);
      if (brhMatch && brfMatch) {
        const hit = parseInt(brhMatch[1]);
        const found = parseInt(brfMatch[1]);
        if (hit < found) {
          branchWarnings.push(`${file}: ${hit}/${found} branches covered`);
        }
      }
    }

    if (branchWarnings.length > 0) {
      console.log("\nBranch coverage gaps (advisory):");
      for (const w of branchWarnings) console.log(`  ${w}`);
    }

    if (failures.length > 0) {
      console.error("\nLine coverage is not 100%. Files below 100%:");
      for (const f of failures) console.error(`  ${f}`);
      console.error("\nTest quality rules:");
      console.error("  - 100% line coverage is required");
      console.error("  - Test outcomes not implementations");
      console.error("  - Test-only exports are forbidden");
      console.error("  - Tautological tests are forbidden");
      Deno.exit(1);
    }

    console.log("\nAll files have 100% line coverage");
  }

  Deno.exit(0);
};

main();
