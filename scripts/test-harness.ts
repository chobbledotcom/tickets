/**
 * Shared setup/teardown for the test runners.
 *
 * Both the full runner (`run-tests.ts`) and the focused runner
 * (`run-test-files.ts`) need the same environment before any test can import
 * the app: the static client assets must be built (the app reads them at
 * module load, see src/features/assets.ts) and stripe-mock must be running
 * with STRIPE_MOCK_HOST/PORT exported. This module owns that lifecycle so a
 * fresh checkout can run either runner without manual preparation, and so any
 * generated assets are cleaned up afterwards rather than left in the tree.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildStaticAssets,
  STATIC_ASSET_OUTFILES,
} from "./build-static-assets.ts";

const STRIPE_MOCK_VERSION = "0.188.0";
export const STRIPE_MOCK_PORT = 12111;
export const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN_DIR = join(projectRoot, ".bin");
const STRIPE_MOCK_PATH = join(BIN_DIR, "stripe-mock");

/** Check if stripe-mock is running */
const isStripeMockRunning = async (): Promise<boolean> => {
  try {
    const conn = await Deno.connect({
      hostname: "127.0.0.1",
      port: STRIPE_MOCK_PORT,
    });
    conn.close();
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
  const url =
    `https://github.com/stripe/stripe-mock/releases/download/v${STRIPE_MOCK_VERSION}/stripe-mock_${STRIPE_MOCK_VERSION}_${platform}_${arch}.tar.gz`;

  const curlCmd = new Deno.Command("curl", {
    args: ["-sL", url, "-o", "-"],
    stderr: "null",
    stdout: "piped",
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

/** Start stripe-mock and return the process (null if one is already running) */
const startStripeMock = async (): Promise<Deno.ChildProcess | null> => {
  if (await isStripeMockRunning()) {
    console.log("stripe-mock already running on port", STRIPE_MOCK_PORT);
    return null;
  }

  await downloadStripeMock();

  console.log("Starting stripe-mock on port", STRIPE_MOCK_PORT);
  const cmd = new Deno.Command(STRIPE_MOCK_PATH, {
    args: ["-http-port", String(STRIPE_MOCK_PORT)],
    stderr: "null",
    stdout: "null",
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

/** True if a file exists on disk */
const fileExists = async (path: string): Promise<boolean> => {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * Build the static client assets, returning a cleanup function that removes
 * only the outputs this call generated. Outputs that already existed (e.g. a
 * developer's prior `deno task build:static`) are left untouched, while a fresh
 * checkout is restored to its asset-free state once tests finish.
 */
const setupStaticAssets = async (): Promise<() => Promise<void>> => {
  const generated: string[] = [];
  for (const outfile of Object.values(STATIC_ASSET_OUTFILES)) {
    const path = join(projectRoot, outfile);
    if (!(await fileExists(path))) generated.push(path);
  }

  await buildStaticAssets({ stop: true });

  return async () => {
    for (const path of generated) {
      await Deno.remove(path).catch(() => {});
    }
  };
};

/** Build the deno test CLI args from the standard flags plus caller extras */
const buildDenoTestArgs = (
  extraArgs: string[],
  useCoverage: boolean,
): string[] => {
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
  args.push(...extraArgs);
  return args;
};

/**
 * Run `deno test` with the standard permission flags. `extraArgs` are appended
 * verbatim — the full runner passes `["test/"]`, the focused runner passes the
 * requested files (and any flags such as `--filter`). Returns the exit code.
 */
export const runTests = async (
  extraArgs: string[],
  useCoverage: boolean,
): Promise<number> => {
  console.log("Running tests...");
  const testCmd = new Deno.Command(Deno.execPath(), {
    args: buildDenoTestArgs(extraArgs, useCoverage),
    cwd: projectRoot,
    env: {
      ...Deno.env.toObject(),
      NO_PROXY: "localhost,127.0.0.1,::1",
      no_proxy: "localhost,127.0.0.1,::1",
      STRIPE_MOCK_HOST: "localhost",
      STRIPE_MOCK_PORT: String(STRIPE_MOCK_PORT),
    },
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  });
  const result = await testCmd.output();
  return result.code;
};

/**
 * Run `task` with the full test environment in place: built static assets, a
 * running stripe-mock, and STRIPE_MOCK_HOST/PORT exported. Afterwards the mock
 * is stopped and any freshly generated static assets are removed, leaving the
 * working tree as it was found even if `task` throws.
 */
export const withTestHarness = async <T>(
  task: () => Promise<T>,
): Promise<T> => {
  const cleanupStaticAssets = await setupStaticAssets();
  const stripeMockProcess = await startStripeMock();

  Deno.env.set("STRIPE_MOCK_HOST", "localhost");
  Deno.env.set("STRIPE_MOCK_PORT", String(STRIPE_MOCK_PORT));

  try {
    return await task();
  } finally {
    if (stripeMockProcess) {
      console.log("Stopping stripe-mock...");
      stripeMockProcess.kill();
    }
    await cleanupStaticAssets();
  }
};
