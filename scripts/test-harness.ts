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
import { TEST_STATE_DIR_ENV } from "../test/test-utils/test-state-env.ts";
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
import { rethrowUnlessNotFound } from "./not-found.ts";
import { projectRoot } from "./project-root.ts";
import { startStripeMock, stripeMockEnv } from "./stripe-mock.ts";
import { JUNIT_PATH } from "./test-durations.ts";

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
    // Install shared test state in every isolate before test-module imports:
    // the fast `toContain` override and the full locale catalog used by direct
    // template tests that do not enter through a production route loader.
    "--preload",
    "./test/test-utils/preload.ts",
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
  estimateFrom?: string[],
): Promise<number> => {
  const env = {
    ...Deno.env.toObject(),
    ...stripeMockEnv(),
  };

  if (useCoverage) await removeOldCoverageOutput();

  if (!hasReporterArg(extraArgs)) {
    const estimatedTotal = await estimateTapEventCount(
      projectRoot,
      estimateFrom ?? extraArgs,
    );
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
 * Build the run-wide test state (golden DB + captured setup ceremony) that
 * every test isolate seeds itself from instead of rebuilding — see
 * test/test-utils/test-state.ts. Returns a cleanup function. When the env var
 * is already set (a nested harness, e.g. a mutation run's child), the existing
 * state is reused and left in place. The import is dynamic so the harness only
 * loads the app graph when it actually builds state.
 */
const setupTestState = async (): Promise<() => Promise<void>> => {
  if (Deno.env.get(TEST_STATE_DIR_ENV)) return async () => {};
  const { writeTestState } = await import("../test/test-utils/test-state.ts");

  const dir = await Deno.makeTempDir({ prefix: "tickets-test-state-" });
  try {
    await writeTestState(dir);
  } catch (error) {
    // Don't leave a half-built state dir behind. The build failure is the
    // error worth surfacing, so this removal is best-effort by design.
    await Deno.remove(dir, { recursive: true }).catch(() => {});
    throw error;
  }
  Deno.env.set(TEST_STATE_DIR_ENV, dir);
  harnessLog("test state prebuilt in", dir);
  return async () => {
    Deno.env.delete(TEST_STATE_DIR_ENV);
    // Only an already-gone dir is expected; anything else (e.g. permissions)
    // must surface rather than silently leave run state on disk.
    await Deno.remove(dir, { recursive: true }).catch(rethrowUnlessNotFound);
  };
};

/**
 * Run `task` with the full test environment in place: built static assets, a
 * running stripe-mock with STRIPE_MOCK_HOST/PORT exported, and the run-wide
 * prebuilt test state exported as TICKETS_TEST_STATE_DIR. Afterwards the mock
 * is stopped and any freshly generated static assets and prebuilt state are
 * removed, leaving the working tree as it was found even if `task` throws.
 */
export const withTestHarness = async <T>(
  task: () => Promise<T>,
): Promise<T> => {
  const cleanupStaticAssets = await setupStaticAssets();
  let stripeMockProcess: Awaited<ReturnType<typeof startStripeMock>> | null =
    null;
  let cleanupTestState: (() => Promise<void>) | null = null;

  try {
    stripeMockProcess = await startStripeMock();
    const mockEnv = stripeMockEnv(stripeMockProcess.port);
    harnessLog("stripe-mock running on port", mockEnv.STRIPE_MOCK_PORT);
    Deno.env.set("STRIPE_MOCK_HOST", mockEnv.STRIPE_MOCK_HOST);
    Deno.env.set("STRIPE_MOCK_PORT", mockEnv.STRIPE_MOCK_PORT);
    cleanupTestState = await setupTestState();
    return await task();
  } finally {
    if (stripeMockProcess) {
      harnessLog("Stopping stripe-mock...");
      await stripeMockProcess.stop();
    }
    if (cleanupTestState) await cleanupTestState();
    await cleanupStaticAssets();
  }
};

/**
 * Run the whole `test/` suite inside the harness, emitting per-test timings to
 * the shared JUnit path. Any stale JUnit file is removed first so a killed prior
 * run can't surface its timings; `deno test --junit-path` rewrites it on a
 * completed run.
 *
 * Test files are grouped into shared isolates (see scripts/test-groups.ts) so
 * the app module graph is evaluated once per group instead of once per file.
 * Set TICKETS_TEST_UNGROUPED=1 to run every file in its own isolate — useful
 * to rule grouping out when chasing a state leak between test files.
 */
export const runSuiteWithHarness = async (
  useCoverage: boolean,
): Promise<number> => {
  // Only a missing file is expected here; a real removal failure (e.g.
  // permissions) must surface rather than leave a stale JUnit file behind.
  await Deno.remove(JUNIT_PATH).catch(rethrowUnlessNotFound);
  return withTestHarness(async () => {
    if (Deno.env.get("TICKETS_TEST_UNGROUPED") === "1") {
      return runTests(["test/"], useCoverage, JUNIT_PATH);
    }
    const { writeTestGroups } = await import("./test-groups.ts");
    const groups = await writeTestGroups(projectRoot);
    try {
      return await runTests(
        groups.runArgs,
        useCoverage,
        JUNIT_PATH,
        groups.testFiles,
      );
    } finally {
      await groups.cleanup();
    }
  });
};
