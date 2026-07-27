import { join } from "node:path";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { projectRoot } from "#scripts/project-root.ts";
import { installLockPath } from "#scripts/stripe-mock/install.ts";
import {
  STRIPE_MOCK_FAILED_TO_START,
  startStripeMock,
} from "#scripts/stripe-mock.ts";
import { withTempDir } from "#test-utils/files.ts";
import { wait } from "#test-utils/mocks.ts";

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

export const expectPortAvailable = (port: number): void => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port });
  listener.close();
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
): Promise<void> =>
  await withTempDir(async (binDir) => {
    const paths = { binaryPath: join(binDir, "stripe-mock"), binDir };
    await body(paths);
  });

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
): Promise<void> =>
  await withTempDir(async (dir) => {
    const fakeCurl = `${dir}/curl`;
    await Deno.writeTextFile(fakeCurl, `#!/bin/sh\n${script}\n`);
    await makeExecutable(fakeCurl);
    await body(fakeCurl);
  });

/** A mock that opens its port, then dies while the starter is confirming it. */
export const writeDiesWhileConfirmingMock = async (
  paths: TestStripeMockPaths,
  aliveMs = 30,
): Promise<void> => {
  await Deno.writeTextFile(
    paths.binaryPath,
    [
      "#!/bin/sh",
      'nc -l -p "$2" -s 127.0.0.1 -w 1 >/dev/null 2>&1 &',
      `sleep ${aliveMs / 1000}`,
      "exit 1",
    ].join("\n"),
  );
  await makeExecutable(paths.binaryPath);
};

/** A mock that keeps its port shut until well after the first few polls. */
export const writeSlowToListenMock = async (
  paths: TestStripeMockPaths,
  quietMs = 300,
): Promise<void> => {
  await Deno.writeTextFile(
    paths.binaryPath,
    ["#!/bin/sh", `sleep ${quietMs / 1000}`, keepPortOpenCommand].join("\n"),
  );
  await makeExecutable(paths.binaryPath);
};

/**
 * A mock that takes a moment to shut down when asked politely, and leaves a
 * note behind once it has. No note means it was killed before it could finish.
 */
export const writeSlowToStopMock = async (
  paths: TestStripeMockPaths,
  notePath: string,
  shutdownMs = 200,
): Promise<void> => {
  await Deno.writeTextFile(
    paths.binaryPath,
    [
      "#!/bin/sh",
      `exec perl -MIO::Socket::INET -e '$SIG{TERM}=sub{ select(undef,undef,undef,${
        shutdownMs / 1000
      }); open(my $fh, ">", $ARGV[2]); close $fh; exit 0 }; my $socket=IO::Socket::INET->new(LocalAddr=>"127.0.0.1", LocalPort=>$ARGV[1], Proto=>"tcp", Listen=>5, Reuse=>1) or die $!; while (1) { my $client=$socket->accept(); close $client if $client; }' -- "$@" ${shellQuote(
        notePath,
      )}`,
    ].join("\n"),
  );
  await makeExecutable(paths.binaryPath);
};

/** Counts how many times the mock binary was started. */
export const writeCountingFailingMock = async (
  paths: TestStripeMockPaths,
  countPath: string,
  message: string,
): Promise<void> => {
  await Deno.writeTextFile(
    paths.binaryPath,
    [
      "#!/bin/sh",
      `echo x >> ${shellQuote(countPath)}`,
      `echo ${shellQuote(message)} >&2`,
      "exit 1",
    ].join("\n"),
  );
  await makeExecutable(paths.binaryPath);
};

/** How many times a counting mock was started. */
export const startCount = async (countPath: string): Promise<number> => {
  const text = await Deno.readTextFile(countPath);
  return text.split("\n").filter((line) => line.length > 0).length;
};

/** A mock that listens somewhere else, so the port it was asked for never opens. */
export const writeWrongPortMock = async (
  paths: TestStripeMockPaths,
  decoyPort: number,
): Promise<void> => {
  await Deno.writeTextFile(
    paths.binaryPath,
    [
      "#!/bin/sh",
      `exec nc -l -p ${decoyPort} -s 127.0.0.1 >/dev/null 2>&1`,
    ].join("\n"),
  );
  await makeExecutable(paths.binaryPath);
};

/** The exact message a failed start threw, for tests that need the whole text. */
export const startFailureMessage = async (
  options: StartOptions,
): Promise<string> => {
  const failures: string[] = [];
  await expect(
    startStripeMock(options).catch((error: Error) => {
      failures.push(error.message);
      throw error;
    }),
  ).rejects.toThrow();
  return failures.join("");
};

/**
 * Run a snippet in its own Deno process, using this project's config so the
 * `#` import names resolve, and say whether it finished in time.
 */
export const runsToCompletion = async (
  source: string,
  timeoutMs = 20_000,
): Promise<boolean> => {
  const scriptPath = await Deno.makeTempFile({ suffix: ".ts" });
  await Deno.writeTextFile(scriptPath, source);
  // Its own coverage folder, thrown away with the script: the run's report
  // cannot read entries for a file that is about to be deleted.
  const coverageDir = await Deno.makeTempDir();
  try {
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        join(projectRoot, "deno.json"),
        scriptPath,
      ],
      env: { DENO_COVERAGE_DIR: coverageDir },
      // Whatever it leaves running is killed once the time is up, so a script
      // that cannot finish on its own comes back as a failure rather than
      // hanging the suite.
      signal: AbortSignal.timeout(timeoutMs),
      stderr: "null",
      stdout: "null",
    }).spawn();
    return (await child.status).success;
  } finally {
    await Deno.remove(scriptPath);
    await Deno.remove(coverageDir, { recursive: true });
  }
};

/** A port nothing is listening on right now. */
export const freePort = (): number => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
};
