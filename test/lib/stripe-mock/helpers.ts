import { join } from "node:path";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { wait } from "#test-utils";
import { installLockPath } from "../../../scripts/stripe-mock/install.ts";
import {
  STRIPE_MOCK_FAILED_TO_START,
  startStripeMock,
} from "../../../scripts/stripe-mock.ts";

export type TestStripeMockPaths = { binDir: string; binaryPath: string };
export type StartOptions = NonNullable<Parameters<typeof startStripeMock>[0]>;

export { wait };

const makeSignal = (): { done: () => void; wait: Promise<void> } => {
  let done!: () => void;
  const wait = new Promise<void>((resolve) => {
    done = resolve;
  });
  return { done, wait };
};

export const testEnv = (values: Record<string, string | undefined>) => ({
  get: (key: string) => values[key],
});

const withPort = async (
  keepOpen: boolean,
  body: (port: number) => Promise<void> | void,
): Promise<void> => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  if (!keepOpen) listener.close();
  try {
    await body(port);
  } finally {
    if (keepOpen) listener.close();
  }
};

export const withUnusedPort = (body: (port: number) => Promise<void> | void) =>
  withPort(false, body);

export const withHeldPort = (body: (port: number) => Promise<void>) =>
  withPort(true, body);

const openPort = (port: number): Promise<Deno.Conn> =>
  Deno.connect({ hostname: "127.0.0.1", port });

export const expectPortOpen = async (port: number): Promise<void> => {
  const conn = await openPort(port);
  conn.close();
};

export const expectStartFails = async (
  options: StartOptions,
  message?: string,
): Promise<void> =>
  withUnusedPort(async (port) => {
    const started = startStripeMock({ ...options, port });
    if (message) await expect(started).rejects.toThrow(message);
    else await expect(started).rejects.toThrow();
  });

export const expectStripeMockFails = (
  options: StartOptions,
  message = STRIPE_MOCK_FAILED_TO_START,
): Promise<void> => expectStartFails(options, message);

export const withTempStripeMockPaths = async (
  body: (paths: TestStripeMockPaths) => Promise<void>,
): Promise<void> => {
  const binDir = await Deno.makeTempDir();
  const paths = { binaryPath: join(binDir, "stripe-mock"), binDir };

  try {
    await body(paths);
  } finally {
    await Deno.remove(binDir, { recursive: true });
  }
};

export const withInstallLockHeld = async (
  paths: TestStripeMockPaths,
  body: (releaseLock: () => Promise<void>) => Promise<void>,
  writeTimestamp = true,
): Promise<void> => {
  const lockPath = installLockPath(paths);
  const lock = await Deno.open(lockPath, { createNew: true, write: true });
  if (writeTimestamp) await Deno.writeTextFile(lockPath, String(Date.now()));
  let released = false;
  const releaseLock = async (): Promise<void> => {
    if (released) return;
    released = true;
    lock.close();
    await Deno.remove(lockPath);
  };

  try {
    await body(releaseLock);
  } finally {
    await releaseLock();
  }
};

export const withSecondLockRefreshHeld = async (
  lockPath: string,
  body: (lockWrite: {
    releaseWrite: () => void;
    waitForWrite: () => Promise<void>;
  }) => Promise<void>,
): Promise<void> => {
  const writeTextFile = Deno.writeTextFile;
  const writeStarted = makeSignal();
  const writeCanFinish = makeSignal();
  let lockWrites = 0;
  const writeTextFileStub = stub(
    Deno,
    "writeTextFile",
    async (path, data, options) => {
      if (String(path) === lockPath && ++lockWrites === 3) {
        writeStarted.done();
        await writeCanFinish.wait;
      }
      return await writeTextFile(path, data, options);
    },
  );

  try {
    await body({
      releaseWrite: writeCanFinish.done,
      waitForWrite: () => writeStarted.wait,
    });
  } finally {
    writeCanFinish.done();
    writeTextFileStub.restore();
  }
};

const withDenoMethodStub = async <
  Method extends "open" | "readTextFile" | "remove" | "writeTextFile",
>(
  method: Method,
  replacement: (original: (typeof Deno)[Method]) => (typeof Deno)[Method],
  body: () => Promise<void>,
): Promise<void> => {
  const original = Deno[method];
  const methodStub = stub(Deno, method, replacement(original) as never);

  try {
    await body();
  } finally {
    methodStub.restore();
  }
};

export const withLockRemovedDuringRead = async (
  lockPath: string,
  body: () => Promise<void>,
): Promise<void> => {
  let removeLock = true;
  await withDenoMethodStub(
    "readTextFile",
    (readTextFile) => async (path) => {
      if (String(path) === lockPath && removeLock) {
        removeLock = false;
        await Deno.remove(lockPath);
      }
      return await readTextFile(path);
    },
    body,
  );
};

export const withLockReadFailure = async (
  lockPath: string,
  body: () => Promise<void>,
): Promise<void> => {
  await withDenoMethodStub(
    "readTextFile",
    () => (path) => {
      expect(String(path)).toBe(lockPath);
      throw new Error("stale check failed");
    },
    body,
  );
};

export const withInstallLockOpenFailure = async (
  paths: TestStripeMockPaths,
  body: () => Promise<void>,
): Promise<void> => {
  const lockPath = installLockPath(paths);
  await withDenoMethodStub(
    "open",
    (open) => (path, options) => {
      if (String(path) !== lockPath || !options?.createNew) {
        return open(path, options);
      }
      throw new Error("install lock create failed");
    },
    body,
  );
};

export const withInstallLockWriteFailure = async (
  paths: TestStripeMockPaths,
  body: (lock: { isClosed: () => boolean }) => Promise<void>,
): Promise<void> => {
  const lockPath = installLockPath(paths);
  let lockClosed = false;
  const fakeLock = {
    close: () => {
      lockClosed = true;
    },
  } as unknown as Deno.FsFile;
  await withDenoMethodStub(
    "open",
    (open) => async (path, options) => {
      if (String(path) !== lockPath || !options?.createNew) {
        return await open(path, options);
      }
      return fakeLock;
    },
    async () => {
      await withDenoMethodStub(
        "writeTextFile",
        () => async (path) => {
          expect(String(path)).toBe(lockPath);
          throw new Error("install lock write failed");
        },
        () => body({ isClosed: () => lockClosed }),
      );
    },
  );
};

export const withInstallLockRemoveFailure = async (
  lockPath: string,
  error: Error,
  body: () => Promise<void>,
): Promise<void> => {
  await withDenoMethodStub(
    "remove",
    (remove) => (path, options) => {
      if (String(path) === lockPath) throw error;
      return remove(path, options);
    },
    body,
  );
};

export const waitForFile = async (path: string): Promise<void> => {
  while (true) {
    try {
      if ((await Deno.stat(path)).isFile) return;
    } catch {
      // Keep waiting for the install to finish writing the file.
    }
    await wait(1);
  }
};

/**
 * Wait until the install's `stripe-mock-*` temp directory has been cleaned up.
 * That removal is the last real-async step before the download flow returns and
 * runs `stopRefreshingLock` — so once it is gone, the remaining path to the lock
 * refresh being stopped is pure microtasks. Waiting on it lets a test release a
 * held refresh write *after* the refresh is stopped, deterministically.
 */
export const waitForNoInstallTempDir = async (
  binDir: string,
): Promise<void> => {
  while (true) {
    let hasTempDir = false;
    for await (const entry of Deno.readDir(binDir)) {
      if (entry.isDirectory && entry.name.startsWith("stripe-mock-")) {
        hasTempDir = true;
        break;
      }
    }
    if (!hasTempDir) return;
    await wait(1);
  }
};

const runCommand = async (command: Deno.Command): Promise<void> => {
  const result = await command.output();
  expect(result.success).toBe(true);
};

const chmod = (mode: string, path: string): Promise<void> =>
  runCommand(
    new Deno.Command("chmod", {
      args: [mode, path],
      stderr: "null",
      stdout: "null",
    }),
  );

export const makeExecutable = (path: string): Promise<void> =>
  chmod("+x", path);

export const createFakeArchive = async (): Promise<{
  archivePath: string;
  cleanup: () => Promise<void>;
}> => {
  const dir = await Deno.makeTempDir();
  const sourceDir = `${dir}/src`;
  const archivePath = `${dir}/stripe-mock.tar.gz`;
  await Deno.mkdir(sourceDir);
  const fakeBinaryPath = `${sourceDir}/stripe-mock`;
  await Deno.writeTextFile(fakeBinaryPath, "#!/bin/sh\nexit 0\n");
  await makeExecutable(fakeBinaryPath);
  await runCommand(
    new Deno.Command("tar", {
      args: ["-czf", archivePath, "-C", sourceDir, "stripe-mock"],
      stderr: "null",
      stdout: "null",
    }),
  );

  return {
    archivePath,
    cleanup: () => Deno.remove(dir, { recursive: true }),
  };
};

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

export const writePortThief = async (
  paths: TestStripeMockPaths,
  repeat = true,
  fallbackCommand = "exit 1",
): Promise<void> => {
  const countPath = join(paths.binDir, "started-once");
  await Deno.writeTextFile(
    paths.binaryPath,
    [
      "#!/bin/sh",
      `if ${repeat ? "true" : `[ ! -f ${shellQuote(countPath)} ]`}; then`,
      `  touch ${shellQuote(countPath)}`,
      '  nc -l -p "$2" -s 127.0.0.1 -w 1 >/dev/null 2>&1 &',
      "  exit 1",
      "fi",
      fallbackCommand,
    ].join("\n"),
  );
  await makeExecutable(paths.binaryPath);
};

export const writeFailingMock = async (
  paths: TestStripeMockPaths,
  message: string,
): Promise<void> => {
  await Deno.writeTextFile(
    paths.binaryPath,
    [
      "#!/bin/sh",
      `echo ${shellQuote(message)} >&2`,
      "sleep 0.05",
      "exit 1",
    ].join("\n"),
  );
  await makeExecutable(paths.binaryPath);
};

export const keepPortOpenCommand = [
  "trap 'kill \"$child\" 2>/dev/null; exit 0' TERM INT",
  "while true; do",
  '  nc -l -p "$2" -s 127.0.0.1 >/dev/null 2>&1 &',
  "  child=$!",
  '  wait "$child"',
  "done",
].join("\n");

export const writeTermIgnoringMock = async (
  paths: TestStripeMockPaths,
): Promise<void> => {
  await Deno.writeTextFile(
    paths.binaryPath,
    [
      "#!/bin/sh",
      'exec perl -MIO::Socket::INET -e \'$SIG{TERM}=sub{}; my $socket=IO::Socket::INET->new(LocalAddr=>"127.0.0.1", LocalPort=>$ARGV[1], Proto=>"tcp", Listen=>5, Reuse=>1) or die $!; while (1) { my $client=$socket->accept(); close $client if $client; }\' -- "$@"',
    ].join("\n"),
  );
  await makeExecutable(paths.binaryPath);
};

export const withFakeCurl = async (
  script: string,
  body: (curlPath: string) => Promise<void>,
): Promise<void> => {
  const dir = await Deno.makeTempDir();
  const fakeCurl = `${dir}/curl`;
  await Deno.writeTextFile(fakeCurl, `#!/bin/sh\n${script}\n`);
  await makeExecutable(fakeCurl);

  try {
    await body(fakeCurl);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};
