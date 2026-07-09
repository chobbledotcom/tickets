/**
 * stripe-mock lifecycle helpers for local and CI tests.
 *
 * The normal test harness starts one stripe-mock process per run on a free
 * local port, then passes that port to every spawned test process. Direct
 * `deno test` runs can still use the default port or an explicit
 * STRIPE_MOCK_PORT.
 */

import { join } from "node:path";
import {
  defaultStripeMockPaths,
  downloadStripeMock,
  type StripeMockCommands,
  type StripeMockInstallOptions,
  type StripeMockPaths,
  wait,
} from "./stripe-mock/install.ts";

const STRIPE_MOCK_HOST = "localhost";
export const DEFAULT_STRIPE_MOCK_PORT = 12111;
export const STRIPE_MOCK_FAILED_TO_START = "stripe-mock failed to start";
const START_CONFIRM_DELAY_MS = 50;
const START_ATTEMPTS = 5;
const STOP_TIMEOUT_MS = 2_000;
const START_LOCK_NAME = "stripe-mock.start.lock";

type StripeMockEnvSource = {
  get: (key: string) => string | undefined;
};

const parsePort = (value: string): number => {
  const port = Number.parseInt(value, 10);
  if (String(port) !== value || port < 1 || port > 65_535) {
    throw new Error("STRIPE_MOCK_PORT must be a number from 1 to 65535");
  }
  return port;
};

export const stripeMockPortFromEnv = (
  env: StripeMockEnvSource = Deno.env,
): number => {
  const port = env.get("STRIPE_MOCK_PORT");
  return port ? parsePort(port) : DEFAULT_STRIPE_MOCK_PORT;
};

type StripeMockEnv = {
  NO_PROXY: string;
  no_proxy: string;
  STRIPE_MOCK_HOST: string;
  STRIPE_MOCK_PORT: string;
};

export const stripeMockEnv = (
  port = stripeMockPortFromEnv(),
): StripeMockEnv => ({
  NO_PROXY: "localhost,127.0.0.1,::1",
  no_proxy: "localhost,127.0.0.1,::1",
  STRIPE_MOCK_HOST,
  STRIPE_MOCK_PORT: String(port),
});

/** Ask the OS for a currently free localhost port. */
const findAvailablePort = (): number => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
};

const chooseStripeMockPort = (env: StripeMockEnvSource): number =>
  env.get("STRIPE_MOCK_PORT")
    ? stripeMockPortFromEnv(env)
    : findAvailablePort();

/** Check whether a process is listening on the stripe-mock port. */
const isStripeMockRunning = async (
  port = stripeMockPortFromEnv(),
): Promise<boolean> => {
  try {
    const conn = await Deno.connect({ hostname: "127.0.0.1", port });
    conn.close();
    return true;
  } catch {
    return false;
  }
};

const raceWithDelay = async <T>(
  first: Promise<T>,
  delayMs: number,
  delayedValue: () => T,
): Promise<T> => {
  let timeout = 0;
  const delayed = new Promise<T>((resolve) => {
    timeout = setTimeout(() => resolve(delayedValue()), delayMs);
  });
  try {
    return await Promise.race([first, delayed]);
  } finally {
    clearTimeout(timeout);
  }
};

const beforeTimeout = (
  status: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> =>
  raceWithDelay(
    status.then(() => true),
    timeoutMs,
    () => false,
  );

const confirmProcessStillRunning = (
  processExited: Promise<void>,
  delayMs: number,
  isExited: () => boolean,
): Promise<boolean> =>
  raceWithDelay(
    processExited.then(() => false),
    delayMs,
    () => !isExited(),
  );

const waitForOwnedStripeMock = async (
  process: Deno.ChildProcess,
  port: number,
  maxAttempts: number,
  delayMs: number,
  confirmDelayMs: number,
): Promise<boolean> => {
  let exited = false;
  const processExited = process.status.then(() => {
    exited = true;
  });

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (exited) return false;
    if (await isStripeMockRunning(port)) {
      return await confirmProcessStillRunning(
        processExited,
        confirmDelayMs,
        () => exited,
      );
    }
    await wait(delayMs);
  }
  return false;
};

type RunningStripeMock = {
  port: number;
  stop: () => Promise<void>;
  stopNow: () => void;
};

type SpawnedStripeMock = {
  closeStderr: () => Promise<void>;
  process: Deno.ChildProcess;
  stderr: () => Promise<string>;
};

type CapturedStreamText = {
  close: () => Promise<void>;
  read: () => Promise<string>;
};

type StartStripeMockOptions = StripeMockInstallOptions & {
  commands?: Partial<StripeMockCommands>;
  choosePort?: (env: StripeMockEnvSource) => number;
  confirmDelayMs?: number;
  delayMs?: number;
  env?: StripeMockEnvSource;
  maxAttempts?: number;
  paths?: StripeMockPaths;
  port?: number;
  startAttempts?: number;
  stopTimeoutMs?: number;
};

const stopManagedProcess = async (
  process: Deno.ChildProcess,
  timeoutMs = STOP_TIMEOUT_MS,
  closeStderr: () => Promise<void> = () => Promise.resolve(),
): Promise<void> => {
  process.ref();
  const status = process.status;
  try {
    try {
      process.kill();
    } catch {
      // It may already have exited.
    }
    const stopped = await beforeTimeout(status, timeoutMs);
    if (!stopped) {
      process.kill("SIGKILL");
      await status;
    }
  } finally {
    await closeStderr();
  }
};

const stopManagedProcessNow = (process: Deno.ChildProcess): void => {
  try {
    process.kill("SIGKILL");
  } catch {
    // It may already have exited.
  }
};

const alreadyRunningStripeMock = (port: number): RunningStripeMock => ({
  port,
  stop: () => Promise.resolve(),
  stopNow: () => {},
});

const managedStripeMock = (
  port: number,
  process: Deno.ChildProcess,
  stopTimeoutMs: number,
  closeStderr: () => Promise<void>,
): RunningStripeMock => {
  process.unref();
  return {
    port,
    stop: () => stopManagedProcess(process, stopTimeoutMs, closeStderr),
    stopNow: () => stopManagedProcessNow(process),
  };
};

const hasConfiguredPort = (
  options: StartStripeMockOptions,
  env: StripeMockEnvSource,
): boolean =>
  options.port !== undefined || env.get("STRIPE_MOCK_PORT") !== undefined;

const spawnStripeMock = (
  paths: StripeMockPaths,
  port: number,
): SpawnedStripeMock => {
  const process = new Deno.Command(paths.binaryPath, {
    args: ["-http-port", String(port)],
    stderr: "piped",
    stdout: "null",
  }).spawn();
  const stderr = captureStreamText(process.stderr);
  return { closeStderr: stderr.close, process, stderr: stderr.read };
};

const captureStreamText = (
  stream: ReadableStream<Uint8Array>,
): CapturedStreamText => ({
  close: () => stream.cancel(),
  read: async () => (await new Response(stream).text()).trim(),
});

const stripeMockStartLockPath = (paths: StripeMockPaths): string =>
  join(paths.binDir, START_LOCK_NAME);

const withStripeMockStartLock = async <T>(
  paths: StripeMockPaths,
  body: () => Promise<T>,
): Promise<T> => {
  await Deno.mkdir(paths.binDir, { recursive: true });
  const lock = await Deno.open(stripeMockStartLockPath(paths), {
    create: true,
    read: true,
    write: true,
  });

  try {
    await lock.lock();
    try {
      return await body();
    } finally {
      lock.unlock();
    }
  } finally {
    lock.close();
  }
};

const startStripeMockProcess = async (
  options: StartStripeMockOptions,
  env: StripeMockEnvSource,
  paths: StripeMockPaths,
  configuredPort: boolean,
  startAttempts: number,
): Promise<RunningStripeMock> => {
  let lastStartupError = "";

  for (let attempt = 0; attempt < startAttempts; attempt++) {
    const choosePort = options.choosePort ?? chooseStripeMockPort;
    const port = options.port ?? choosePort(env);
    if (await isStripeMockRunning(port)) {
      if (configuredPort) return alreadyRunningStripeMock(port);
      continue;
    }

    if (configuredPort) await downloadStripeMock(options);

    const spawned = spawnStripeMock(paths, port);

    if (
      await waitForOwnedStripeMock(
        spawned.process,
        port,
        options.maxAttempts ?? 100,
        options.delayMs ?? 100,
        options.confirmDelayMs ?? START_CONFIRM_DELAY_MS,
      )
    ) {
      return managedStripeMock(
        port,
        spawned.process,
        options.stopTimeoutMs ?? STOP_TIMEOUT_MS,
        spawned.closeStderr,
      );
    }

    await stopManagedProcess(
      spawned.process,
      options.stopTimeoutMs ?? STOP_TIMEOUT_MS,
    );
    lastStartupError = await spawned.stderr();
  }

  throw new Error(
    lastStartupError
      ? `${STRIPE_MOCK_FAILED_TO_START}: ${lastStartupError}`
      : STRIPE_MOCK_FAILED_TO_START,
  );
};

export const startStripeMock = async (
  options: StartStripeMockOptions = {},
): Promise<RunningStripeMock> => {
  const env = options.env ?? Deno.env;
  const paths = options.paths ?? defaultStripeMockPaths;
  const configuredPort = hasConfiguredPort(options, env);
  const startAttempts = configuredPort
    ? 1
    : (options.startAttempts ?? START_ATTEMPTS);
  if (!configuredPort) await downloadStripeMock(options);

  const start = () =>
    startStripeMockProcess(options, env, paths, configuredPort, startAttempts);
  return configuredPort
    ? await start()
    : await withStripeMockStartLock(paths, start);
};
