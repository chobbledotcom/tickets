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
import { config } from "./config.ts";
import { log, warn } from "./log.ts";
import { sleep, stopChild } from "./util.ts";

/* jscpd:ignore-end */

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "..", "..");

export interface AppServer {
  /** Local base URL, e.g. http://127.0.0.1:38123 */
  localBaseUrl: string;
  /** Path to the app server's captured stdout/stderr log. */
  logPath: string;
  port: number;
  stop: () => Promise<void>;
}

/** Pick a port in a high range; the OS will reject a genuine clash on bind. */
const pickPort = (): number => 34_000 + Math.floor(Math.random() * 4_000);

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

export const startAppServer = async (): Promise<AppServer> => {
  const port = pickPort();
  const artifactsDir = join(repoRoot, "e2e-payments", config.artifactsDir);
  mkdirSync(artifactsDir, { recursive: true });

  const dbDir = join(repoRoot, "e2e-payments", ".tmp");
  rmSync(dbDir, { force: true, recursive: true });
  mkdirSync(dbDir, { recursive: true });
  const dbUrl = `file:${join(dbDir, "e2e.db")}`;

  const logPath = join(artifactsDir, `server-${port}.log`);
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
        ...process.env,
        DB_ENCRYPTION_KEY: config.dbEncryptionKey,
        DB_URL: dbUrl,
        PORT: String(port),
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
      const res = await fetch(`${localBaseUrl}/health`);
      if (res.ok) {
        await res.body?.cancel();
        log(`App server is up at ${localBaseUrl} (log: ${logPath})`);
        return {
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
    await sleep(500);
  }
  child.kill("SIGKILL");
  throw new Error(
    `App server did not become healthy within ${config.serverBootTimeoutMs}ms (see ${logPath})`,
  );
};
