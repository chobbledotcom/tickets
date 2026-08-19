/**
 * Stand-in stripe-mock binaries and process helpers for the lifecycle suite.
 *
 * Each one is a tiny executable that behaves badly in one specific way, so a
 * test can watch how the starter copes with it.
 */

import { join } from "node:path";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { projectRoot } from "#scripts/project-root.ts";
import { startStripeMock } from "#scripts/stripe-mock.ts";
import {
  keepPortOpenCommand,
  makeExecutable,
  type StartOptions,
  shellQuote,
  type TestStripeMockPaths,
} from "#test-utils/stripe-mock/helpers.ts";

/** A mock that opens its port, then does whatever the given perl says next. */
const writeListeningPerlMock = async (
  paths: TestStripeMockPaths,
  afterListening: string,
): Promise<void> => {
  await Deno.writeTextFile(
    paths.binaryPath,
    [
      "#!/bin/sh",
      `exec perl -MIO::Socket::INET -e 'my $socket=IO::Socket::INET->new(LocalAddr=>"127.0.0.1", LocalPort=>$ARGV[1], Proto=>"tcp", Listen=>5, Reuse=>1) or die $!; ${afterListening}' -- "$@"`,
    ].join("\n"),
  );
  await makeExecutable(paths.binaryPath);
};

/**
 * A mock that serves its port for a while and then stops on its own, so a test
 * that deliberately walks away from one does not leave it behind.
 */
export const writeShortLivedMock = async (
  paths: TestStripeMockPaths,
  lifetimeSeconds = 8,
): Promise<void> => {
  await writeListeningPerlMock(
    paths,
    `alarm ${lifetimeSeconds}; while (1) { my $client=$socket->accept(); close $client if $client; }`,
  );
};

/** A mock that opens its port, then dies while the starter is confirming it. */
export const writeDiesWhileConfirmingMock = async (
  paths: TestStripeMockPaths,
  aliveMs = 30,
): Promise<void> => {
  // It waits to be looked at before it starts dying, so a slow machine cannot
  // turn this into a mock that died before anyone ever saw it listening.
  await writeListeningPerlMock(
    paths,
    `my $client=$socket->accept(); close $client if $client; select(undef,undef,undef,${
      aliveMs / 1000
    }); exit 1`,
  );
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
 * It also notes when it wins its port: no bound note means the mock never got
 * to run at all (something else took the port), which is a different story
 * from being killed too early.
 */
export const writeSlowToStopMock = async (
  paths: TestStripeMockPaths,
  notePath: string,
  boundNotePath: string,
  shutdownMs = 200,
): Promise<void> => {
  await Deno.writeTextFile(
    paths.binaryPath,
    [
      "#!/bin/sh",
      `exec perl -MIO::Socket::INET -e '$SIG{TERM}=sub{ select(undef,undef,undef,${
        shutdownMs / 1000
      }); open(my $fh, ">", $ARGV[2]); close $fh; exit 0 }; my $socket=IO::Socket::INET->new(LocalAddr=>"127.0.0.1", LocalPort=>$ARGV[1], Proto=>"tcp", Listen=>5, Reuse=>1) or die $!; open(my $bound, ">", $ARGV[3]); close $bound; while (1) { my $client=$socket->accept(); close $client if $client; }' -- "$@" ${shellQuote(
        notePath,
      )} ${shellQuote(boundNotePath)}`,
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
  env: Record<string, string> = {},
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
      env: { ...env, DENO_COVERAGE_DIR: coverageDir },
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

type ConnectCalls = { count: number };

/**
 * Count what the starter does when it looks for an open port, and optionally
 * make some of those looks fail however open the port really is.
 */
export const withCountedLooks = async (
  lookFails: (lookNumber: number) => boolean,
  body: (looks: ConnectCalls) => Promise<void>,
): Promise<void> => {
  const connect = Deno.connect;
  const looks: ConnectCalls = { count: 0 };
  using _connect = stub(Deno, "connect", ((options: Deno.ConnectOptions) => {
    looks.count += 1;
    if (lookFails(looks.count)) {
      return Promise.reject(new Deno.errors.ConnectionRefused("not yet"));
    }
    return connect(options);
  }) as typeof Deno.connect);

  await body(looks);
};
