/* jscpd:ignore-start */
import { join } from "node:path";
import type { LockBody } from "#scripts/lock-file.ts";
import { removeTree } from "#scripts/process.ts";
import { projectRoot } from "#scripts/project-root.ts";
import { type StaleClaimSettings, withClaim } from "#scripts/stale-claim.ts";

/* jscpd:ignore-end */

const STRIPE_MOCK_VERSION = "0.188.0";
const INSTALL_LOCK_RETRY_MS = 50;
const INSTALL_LOCK_TIMEOUT_MS = 60_000;
const INSTALL_LOCK_STALE_MS = 30_000;
const INSTALL_LOCK_TOUCH_MS = 1_000;
const INSTALL_TEMP_PREFIX = "stripe-mock-";

const BIN_DIR = join(projectRoot, ".bin");
const STRIPE_MOCK_PATH = join(BIN_DIR, "stripe-mock");

export type StripeMockPaths = {
  binDir: string;
  binaryPath: string;
};

/** Ensure the bin directory (and any parents) exists. */
const ensureBinDir = (paths: StripeMockPaths): Promise<void> =>
  Deno.mkdir(paths.binDir, { recursive: true });

/**
 * A guard on a file in the bin folder: say how the file holds callers out,
 * get back "make the folder, then hold the guard around the work". The
 * install lock here and the start lock in stripe-mock.ts are both one of
 * these.
 */
export const binDirGuard =
  (holdAt: (paths: StripeMockPaths) => <T>(body: LockBody<T>) => Promise<T>) =>
  async <T>(paths: StripeMockPaths, body: LockBody<T>): Promise<T> => {
    await ensureBinDir(paths);
    return holdAt(paths)(body);
  };

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

/**
 * What stripe-mock calls this machine in its release names, which is not always
 * what Deno calls it. Everything that is not a Mac is named as Linux, and every
 * processor that is not 64-bit ARM is named as amd64.
 */
const getPlatform = (): string =>
  Deno.build.os === "darwin" ? "darwin" : "linux";

const getArch = (): string =>
  Deno.build.arch === "aarch64" ? "arm64" : "amd64";

const stripeMockDownloadUrl = (): string =>
  `https://github.com/stripe/stripe-mock/releases/download/v${STRIPE_MOCK_VERSION}/stripe-mock_${STRIPE_MOCK_VERSION}_${getPlatform()}_${getArch()}.tar.gz`;

const runCommand = async (
  command: Deno.Command,
  message: string,
): Promise<Deno.CommandOutput> => {
  const output = await command.output();
  const stderr = textDecoder.decode(output.stderr).trim();
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

const installLockSettings = ({
  // Only a missing setting takes the standard value, so an explicit one —
  // including a deliberate zero — is always kept.
  installLockRetryMs: retryMs = INSTALL_LOCK_RETRY_MS,
  installLockStaleMs: staleMs = INSTALL_LOCK_STALE_MS,
  installLockTimeoutMs: timeoutMs = INSTALL_LOCK_TIMEOUT_MS,
  installLockTouchMs: touchMs = INSTALL_LOCK_TOUCH_MS,
}: StripeMockInstallOptions): StaleClaimSettings & {
  retryMs: number;
  timeoutMs: number;
} => ({
  retryMs,
  staleMs,
  timeoutMs,
  touchMs,
});

const installLockHolder = (options: StripeMockInstallOptions) =>
  binDirGuard(
    (paths) => (body) =>
      withClaim(
        installLockPath(paths),
        { ...installLockSettings(options), name: "stripe-mock install lock" },
        body,
      ),
  );

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
        stderr: "piped",
        stdout: "null",
      }),
      "Failed to extract stripe-mock",
    );

    await runCommand(
      new Deno.Command(commands.chmod, {
        args: ["+x", tempBinaryPath],
        stderr: "piped",
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

  await installLockHolder(options)(paths, async () => {
    if (await stripeMockBinaryExists(paths)) return;
    await installStripeMock(paths, commandsWithDefaults(options.commands));
  });
};
