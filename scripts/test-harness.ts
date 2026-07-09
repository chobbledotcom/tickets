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

import { join } from "node:path";
import {
  buildStaticAssets,
  STATIC_ASSET_OUTFILES,
} from "./build-static-assets.ts";
import {
  estimateTapEventCount,
  hasReporterArg,
  runCompactDenoTest,
} from "./compact-test-reporter.ts";
import {
  COVERAGE_OUTPUT_DIR,
  removeOldCoverageOutput,
} from "./coverage-output.ts";
import { projectRoot } from "./project-root.ts";
import { startStripeMock, stripeMockEnv } from "./stripe-mock.ts";

const verboseHarness = Deno.env.get("TICKETS_TEST_HARNESS_VERBOSE") === "1";

const harnessLog = (...args: unknown[]): void => {
  if (verboseHarness) console.log(...args);
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

  await buildStaticAssets({ quiet: true, stop: true });

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
  reporter?: "tap",
  junitPath?: string,
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
    // Expose `globalThis.gc` so the test DB layer can reclaim libsql's
    // file-descriptor leak (a fresh client per test + every interactive
    // transaction leaks an fd that close() never releases — only GC does). Under
    // high --parallel worker counts these outrun GC and exhaust the process fd
    // limit ("Too many open files"), which surfaces as flaky, moving failures.
    // See maybeReclaimLeakedFds in test/test-utils/db.ts.
    "--v8-flags=--expose-gc",
  ];
  if (reporter) args.push("--reporter", reporter);
  if (useCoverage) args.push(`--coverage=${COVERAGE_OUTPUT_DIR}`);
  if (junitPath) args.push("--junit-path", junitPath);
  args.push(...extraArgs);
  return args;
};

/**
 * Run `deno test` with the standard permission flags. `extraArgs` are appended
 * verbatim — the full runner passes `["test/"]`, the focused runner passes the
 * requested files (and any flags such as `--filter`). `junitPath`, when set,
 * makes `deno test` write a JUnit XML file the caller can parse for per-test
 * timings. Returns the exit code.
 */
export const runTests = async (
  extraArgs: string[],
  useCoverage: boolean,
  junitPath?: string,
): Promise<number> => {
  const env = {
    ...Deno.env.toObject(),
    ...stripeMockEnv(),
  };

  if (useCoverage) await removeOldCoverageOutput();

  if (!hasReporterArg(extraArgs)) {
    const estimatedTotal = await estimateTapEventCount(projectRoot, extraArgs);
    return await runCompactDenoTest(
      buildDenoTestArgs(extraArgs, useCoverage, "tap", junitPath),
      {
        cwd: projectRoot,
        env,
        ...(estimatedTotal === undefined ? {} : { estimatedTotal }),
      },
    );
  }

  console.log("Running tests...");
  const testCmd = new Deno.Command(Deno.execPath(), {
    args: buildDenoTestArgs(extraArgs, useCoverage, undefined, junitPath),
    cwd: projectRoot,
    env,
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
  let stripeMockProcess: Awaited<ReturnType<typeof startStripeMock>> | null =
    null;

  try {
    stripeMockProcess = await startStripeMock();
    const mockEnv = stripeMockEnv(stripeMockProcess.port);
    harnessLog("stripe-mock running on port", mockEnv.STRIPE_MOCK_PORT);
    Deno.env.set("STRIPE_MOCK_HOST", mockEnv.STRIPE_MOCK_HOST);
    Deno.env.set("STRIPE_MOCK_PORT", mockEnv.STRIPE_MOCK_PORT);
    return await task();
  } finally {
    if (stripeMockProcess) {
      harnessLog("Stopping stripe-mock...");
      await stripeMockProcess.stop();
    }
    await cleanupStaticAssets();
  }
};
