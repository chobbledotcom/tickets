#!/usr/bin/env -S deno run --allow-all
/**
 * Test runner script that ensures stripe-mock is running before tests
 */

import { dirname, fromFileUrl, join } from "jsr:@std/path@1";

const STRIPE_MOCK_VERSION = "0.188.0";
const STRIPE_MOCK_PORT = 12111;
const projectRoot = join(dirname(fromFileUrl(import.meta.url)), "..");
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

  Deno.exit(result.code);
};

main();
