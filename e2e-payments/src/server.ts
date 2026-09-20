/**
 * Boots the real Deno app server as a child process against a throwaway local
 * libsql file DB, and tears it down. This is the *actual* production entrypoint
 * (src/index.ts) — no mocks, no in-process test harness.
 */

/* jscpd:ignore-start */
import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { delay } from "#shared/now.ts";
import { config } from "./config.ts";
import { log, warn } from "./log.ts";
import { probeSignal, stopChild } from "./util.ts";

/* jscpd:ignore-end */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

/** The one artifact root every harness module writes under — screenshots,
 * journals, Cucumber reports, and server logs all derive from the configured
 * directory here, so `E2E_ARTIFACTS_DIR` moves all of them together. */
export const artifactsRoot = join(
  repoRoot,
  "e2e-payments",
  config.artifactsDir,
);

export interface AppServer {
  /** The exact libsql URL of this server's fresh ephemeral database. */
  dbUrl: string;
  /** Local base URL, e.g. http://127.0.0.1:38123 */
  localBaseUrl: string;
  /** Path to the app server's captured stdout/stderr log. */
  logPath: string;
  port: number;
  stop: () => Promise<void>;
}

/** Pick a port in a high range; the OS will reject a genuine clash on bind. */
const pickPort = (): number => 34_000 + Math.floor(Math.random() * 4_000);

/** The child's env without NTFY_URL and SENTRY_URL (the app under test must
 * never notify) and without TEST_SUPPRESS_DEBUG_LOGS — the harness reads the
 * app's debug log lines as evidence (provider ids, webhook processing,
 * refusal counts), so an inherited suppression flag would blind those
 * assertions. */
const appServerEnv = (
  env: Record<string, string | undefined>,
): Record<string, string | undefined> => {
  const {
    NTFY_URL: _droppedNtfy,
    SENTRY_URL: _droppedSentry,
    TEST_SUPPRESS_DEBUG_LOGS: _droppedSuppress,
    ...rest
  } = env;
  return rest;
};

/** Build the static client assets the app reads at import time. Run once. */
export const buildStaticAssets = async (): Promise<void> => {
  log("Building static assets (deno task build:static)…");
  await new Promise<void>((resolveP, reject) => {
    const child = spawn(config.denoBin, ["task", "build:static"], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolveP()
        : reject(new Error(`build:static exited ${code}`)),
    );
  });
};

export const startAppServer = async (
  extraEnv: Record<string, string | undefined> = {},
): Promise<AppServer> => {
  const port = pickPort();
  mkdirSync(artifactsRoot, { recursive: true });

  const dbDir = join(repoRoot, "e2e-payments", ".tmp");
  rmSync(dbDir, { force: true, recursive: true });
  mkdirSync(dbDir, { recursive: true });
  const dbUrl = `file:${join(dbDir, "e2e.db")}`;

  const logPath = join(artifactsRoot, `server-${port}.log`);
  const logStream = createWriteStream(logPath, { flags: "a" });

  log(`Starting app server on port ${port} (db ${dbUrl})…`);
  const child: ChildProcess = spawn(
    config.denoBin,
    [
      "run",
      "--allow-net",
      "--allow-env",
      "--allow-read",
      "--allow-write",
      "--allow-sys",
      "--allow-ffi",
      "src/index.ts",
    ],
    {
      cwd: repoRoot,
      env: {
        // Drop the error-reporting env (appServerEnv): the scenarios
        // deliberately cause real server errors (the Money fault, the SumUp
        // refusals, the price-change refund), and the app under test would
        // faithfully report each one — making a green run look like an
        // incident in ntfy or the bug catcher. The harness's own crash
        // report is the only one a run should send.
        ...appServerEnv(process.env),
        // The plan scenario publishes a built-site plan, which the write path
        // only accepts on a builder-enabled install. The sandbox has no build
        // infrastructure, so the plan's post-payment build fails cleanly —
        // the documented per-entry continue the scenario asserts.
        CAN_BUILD_SITES: "true",
        DB_ENCRYPTION_KEY: config.dbEncryptionKey,
        DB_URL: dbUrl,
        PORT: String(port),
        // A scenario can ask for more (the dry-run plan case sets
        // SITE_BUILD_DRY_RUN, whose app server answers the site-build
        // provider calls from canned bodies — the test-only mode documented
        // in the repository's env-vars).
        ...extraEnv,
      },
    },
  );
  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);
  child.on("exit", (code) => {
    if (code && code !== 0) warn(`app server exited with code ${code}`);
  });

  const localBaseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + config.serverBootTimeoutMs;
  while (Date.now() < deadline) {
    try {
      // Bounded by what is left of the boot deadline, so one hung probe
      // cannot carry the loop past its budget.
      const res = await fetch(`${localBaseUrl}/health`, {
        signal: probeSignal(deadline),
      });
      if (res.ok) {
        await res.body?.cancel();
        log(`App server is up at ${localBaseUrl} (log: ${logPath})`);
        return {
          dbUrl,
          localBaseUrl,
          logPath,
          port,
          stop: stopChild(child),
        };
      }
      await res.body?.cancel();
    } catch {
      // not up yet
    }
    await delay(500);
  }
  child.kill("SIGKILL");
  throw new Error(
    `App server did not become healthy within ${config.serverBootTimeoutMs}ms (see ${logPath})`,
  );
};
