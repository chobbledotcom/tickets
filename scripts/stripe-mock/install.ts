/* jscpd:ignore-start */
import { join } from "node:path";
import { withFileLock } from "#scripts/lock-file.ts";
import { rethrowUnlessNotFound } from "#scripts/not-found.ts";
import { removeTree } from "#scripts/process.ts";
import { projectRoot } from "#scripts/project-root.ts";
import { delay } from "#shared/now.ts";

/* jscpd:ignore-end */

const STRIPE_MOCK_VERSION = "0.188.0";
const INSTALL_LOCK_RETRY_MS = 50;
const INSTALL_LOCK_TIMEOUT_MS = 60_000;
const INSTALL_LOCK_STALE_MS = 30_000;
const INSTALL_LOCK_TOUCH_MS = 1_000;
const INSTALL_TEMP_PREFIX = "stripe-mock-";
const INSTALL_LOCK_GUARD_SUFFIX = ".guard";

const BIN_DIR = join(projectRoot, ".bin");
const STRIPE_MOCK_PATH = join(BIN_DIR, "stripe-mock");

const platformMap: Record<string, string> = { darwin: "darwin" };
const archMap: Record<string, string> = { aarch64: "arm64" };

export type StripeMockPaths = {
  binDir: string;
  binaryPath: string;
};

/** A task run while a lock is held, giving back its result. */
export type LockBody<T> = () => Promise<T>;

/** Ensure the bin directory (and any parents) exists. */
export const ensureBinDir = (paths: StripeMockPaths): Promise<void> =>
  Deno.mkdir(paths.binDir, { recursive: true });

export type StripeMockCommands = {
  chmod: string;
  curl: string;
  tar: string;
};

export type StripeMockInstallOptions = {
  commands?: Partial<StripeMockCommands>;
  installLockRetryMs?: number;
  installLockStaleMs?: number;
  installLockTimeoutMs?: number;
  installLockTouchMs?: number;
  paths?: StripeMockPaths;
};

type InstallLockSettings = {
  retryMs: number;
  staleMs: number;
  timeoutMs: number;
  touchMs: number;
};

type InstallLock = {
  file: Deno.FsFile;
  owner: string;
};

type InstallLockRecord = {
  owner?: string;
  writtenAt: number;
};

export const defaultStripeMockPaths: StripeMockPaths = {
  binaryPath: STRIPE_MOCK_PATH,
  binDir: BIN_DIR,
};

const defaultCommands: StripeMockCommands = {
  chmod: "chmod",
  curl: "curl",
  tar: "tar",
};

const textDecoder = new TextDecoder();

/** What stripe-mock calls this machine, which is not always what Deno calls it. */
const getPlatform = (): string => platformMap[Deno.build.os] ?? "linux";

const getArch = (): string => archMap[Deno.build.arch] ?? "amd64";

const stripeMockDownloadUrl = (): string =>
  `https://github.com/stripe/stripe-mock/releases/download/v${STRIPE_MOCK_VERSION}/stripe-mock_${STRIPE_MOCK_VERSION}_${getPlatform()}_${getArch()}.tar.gz`;

const runCommand = async (
  command: Deno.Command,
  message: string,
): Promise<Deno.CommandOutput> => {
  const output = await command.output();
  let stderr = "";
  try {
    stderr = textDecoder.decode(output.stderr).trim();
  } catch {
    stderr = "";
  }
  if (!output.success)
    throw new Error(stderr ? `${message}: ${stderr}` : message);
  return output;
};

const stripeMockBinaryExists = async (
  paths: StripeMockPaths,
): Promise<boolean> => {
  try {
    const stat = await Deno.stat(paths.binaryPath);
    return stat.isFile;
  } catch {
    return false;
  }
};

export const installLockPath = (paths: StripeMockPaths): string =>
  join(paths.binDir, "stripe-mock.install.lock");

const installLockGuardPath = (lockPath: string): string =>
  `${lockPath}${INSTALL_LOCK_GUARD_SUFFIX}`;

const installLockSettings = ({
  // Only a missing setting takes the standard value, so an explicit one —
  // including a deliberate zero — is always kept.
  installLockRetryMs: retryMs = INSTALL_LOCK_RETRY_MS,
  installLockStaleMs: staleMs = INSTALL_LOCK_STALE_MS,
  installLockTimeoutMs: timeoutMs = INSTALL_LOCK_TIMEOUT_MS,
  installLockTouchMs: touchMs = INSTALL_LOCK_TOUCH_MS,
}: StripeMockInstallOptions): InstallLockSettings => ({
  retryMs,
  staleMs,
  timeoutMs,
  touchMs,
});

const formatInstallLockRecord = (owner: string): string =>
  `${owner}\n${Date.now()}`;

const parseInstallLockRecord = (text: string): InstallLockRecord => {
  // Splitting always yields at least one part, so first is always a string.
  const [first, second] = text.split("\n") as [string, string?];
  const writtenAt = Number(second ?? first);
  return second === undefined ? { writtenAt } : { owner: first, writtenAt };
};

const readInstallLockRecord = async (
  lockPath: string,
): Promise<InstallLockRecord> => {
  const record = parseInstallLockRecord(await Deno.readTextFile(lockPath));
  if (record.writtenAt > 0) return record;

  const stat = await Deno.stat(lockPath);
  return { ...record, writtenAt: stat.mtime!.getTime() };
};

const writeInstallLockTime = (lockPath: string, owner: string): Promise<void> =>
  Deno.writeTextFile(lockPath, formatInstallLockRecord(owner));

const startInstallLockRefresh = (
  lockPath: string,
  owner: string,
  touchMs: number,
) => {
  let stopped = false;
  let timeout = setTimeout(refreshLock, touchMs);
  let latestRefresh: Promise<void> = Promise.resolve();

  const scheduleNextRefresh = () => {
    if (stopped) return;
    timeout = setTimeout(refreshLock, touchMs);
  };

  function refreshLock() {
    latestRefresh = writeInstallLockTime(lockPath, owner).then(
      scheduleNextRefresh,
      scheduleNextRefresh,
    );
  }

  return async (): Promise<void> => {
    stopped = true;
    clearTimeout(timeout);
    await latestRefresh;
    clearTimeout(timeout);
  };
};

const installLockAgeMs = async (lockPath: string): Promise<number> =>
  Date.now() - (await readInstallLockRecord(lockPath)).writtenAt;

const removeStaleInstallLock = async (
  lockPath: string,
  staleMs: number,
): Promise<boolean> => {
  try {
    if ((await installLockAgeMs(lockPath)) < staleMs) return false;
    await Deno.remove(lockPath);
    return true;
  } catch (error) {
    // NotFound: another runner already cleared the stale lock — it's gone
    // either way, which is exactly what this returns true for.
    rethrowUnlessNotFound(error);
    return true;
  }
};

const removeLockIfOwned = async (
  lockPath: string,
  owner: string,
): Promise<void> => {
  try {
    if ((await readInstallLockRecord(lockPath)).owner === owner) {
      await Deno.remove(lockPath);
    }
  } catch (error) {
    rethrowUnlessNotFound(error);
  }
};

const createInstallLock = async (lockPath: string): Promise<InstallLock> => {
  const owner = crypto.randomUUID();
  const file = await Deno.open(lockPath, { createNew: true, write: true });
  try {
    await writeInstallLockTime(lockPath, owner);
    return { file, owner };
  } catch (error) {
    file.close();
    throw error;
  }
};

const tryAcquireInstallLock = (
  lockPath: string,
  settings: InstallLockSettings,
): Promise<InstallLock | null> =>
  withFileLock(installLockGuardPath(lockPath), async () => {
    try {
      return await createInstallLock(lockPath);
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      if (await removeStaleInstallLock(lockPath, settings.staleMs)) {
        return await createInstallLock(lockPath);
      }
      return null;
    }
  });

const acquireInstallLock = async (
  lockPath: string,
  settings: InstallLockSettings,
): Promise<InstallLock> => {
  const startedAt = Date.now();
  while (true) {
    const lock = await tryAcquireInstallLock(lockPath, settings);
    if (lock) return lock;

    if (Date.now() - startedAt >= settings.timeoutMs) {
      throw new Error("Timed out waiting for stripe-mock install lock");
    }
    await delay(settings.retryMs);
  }
};

const withInstallLock = async <T>(
  paths: StripeMockPaths,
  options: StripeMockInstallOptions,
  body: LockBody<T>,
): Promise<T> => {
  const lockPath = installLockPath(paths);
  const settings = installLockSettings(options);
  await ensureBinDir(paths);
  const lock = await acquireInstallLock(lockPath, settings);
  const stopRefreshingLock = startInstallLockRefresh(
    lockPath,
    lock.owner,
    settings.touchMs,
  );

  try {
    return await body();
  } finally {
    try {
      await stopRefreshingLock();
    } finally {
      lock.file.close();
      await removeLockIfOwned(lockPath, lock.owner);
    }
  }
};

const commandsWithDefaults = (
  commands: Partial<StripeMockCommands> | undefined,
): StripeMockCommands => ({ ...defaultCommands, ...commands });

const removeStaleInstallTempDirs = async (binDir: string): Promise<void> => {
  for await (const entry of Deno.readDir(binDir)) {
    if (entry.isDirectory && entry.name.startsWith(INSTALL_TEMP_PREFIX)) {
      await removeTree(join(binDir, entry.name));
    }
  }
};

const installStripeMock = async (
  paths: StripeMockPaths,
  commands: StripeMockCommands,
): Promise<void> => {
  await removeStaleInstallTempDirs(paths.binDir);
  const tempDir = await Deno.makeTempDir({
    dir: paths.binDir,
    prefix: INSTALL_TEMP_PREFIX,
  });
  const tarPath = join(tempDir, "stripe-mock.tar.gz");
  const tempBinaryPath = join(tempDir, "stripe-mock");

  try {
    const curlResult = await runCommand(
      new Deno.Command(commands.curl, {
        args: ["--fail", "-sL", stripeMockDownloadUrl(), "-o", "-"],
        stderr: "piped",
        stdout: "piped",
      }),
      "Failed to download stripe-mock",
    );

    await Deno.writeFile(tarPath, curlResult.stdout);

    await runCommand(
      new Deno.Command(commands.tar, {
        args: ["-xzf", tarPath, "-C", tempDir],
        stderr: "null",
        stdout: "null",
      }),
      "Failed to extract stripe-mock",
    );

    await runCommand(
      new Deno.Command(commands.chmod, {
        args: ["+x", tempBinaryPath],
        stderr: "null",
        stdout: "null",
      }),
      "Failed to make stripe-mock executable",
    );

    await Deno.rename(tempBinaryPath, paths.binaryPath);
  } finally {
    await removeTree(tempDir);
  }
};

/**
 * Download stripe-mock if the binary is missing.
 * Uses curl instead of fetch to avoid Deno TLS certificate issues.
 */
export const downloadStripeMock = async (
  options: StripeMockInstallOptions,
): Promise<void> => {
  const { paths = defaultStripeMockPaths } = options;
  if (await stripeMockBinaryExists(paths)) return;

  await withInstallLock(paths, options, async () => {
    if (await stripeMockBinaryExists(paths)) return;
    await installStripeMock(paths, commandsWithDefaults(options.commands));
  });
};
