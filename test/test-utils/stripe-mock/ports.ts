/**
 * Finding a port to run a mock on, and saying what should happen when one is
 * started. Kept apart from the rest of the stripe-mock helpers because ports
 * are their own concern: a handout holds the port it gives out.
 */

import { join } from "node:path";
import {
  STRIPE_MOCK_FAILED_TO_START,
  startStripeMock,
} from "#scripts/stripe-mock.ts";
import { says } from "#test-utils/says.ts";
import type { StartOptions } from "#test-utils/stripe-mock/helpers.ts";

type StartedStripeMock = Awaited<ReturnType<typeof startStripeMock>>;

/** How many times a taken port is forgiven before the test is failed. */
const PORT_STEAL_TRIES = 5;

/**
 * Lock files name the ports this run has handed out and not seen used yet.
 * The workers of one test run share the process, so one directory serves the
 * whole run, and a lock lives exactly as long as its handout.
 */
const heldPortDir = join("/tmp", `tickets-held-ports-${Deno.pid}`);

/** The claims this isolate still holds. An isolate that exits before its
 * bodies finished cannot run their finally, so the unload below takes the
 * claims away instead of leaving their ports locked for the rest of the run.
 * The runner still polls the event loop after the exit, so a body can settle
 * after that; every claim releases once, and a late release is a no-op. */
const heldLocks = new Set<{ release: () => void }>();

globalThis.addEventListener("unload", () => {
  for (const claim of heldLocks) claim.release();
});

/**
 * Claim a free localhost port for one handout. Creating the lock file is the
 * claim: no other handout of this run can create the same name, so no two
 * handouts receive the same port. The listener keeps the port out of the
 * kernel's free pool until the claim is made.
 */
const claimPort = (
  keepOpen: boolean,
): { port: number; release: () => void } => {
  Deno.mkdirSync(heldPortDir, { recursive: true });
  for (let tries = 0; tries < PORT_STEAL_TRIES; tries++) {
    const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const { port } = listener.addr as Deno.NetAddr;
    const lockPath = join(heldPortDir, `${port}.lock`);
    try {
      Deno.openSync(lockPath, { createNew: true, write: true }).close();
    } catch (error) {
      listener.close();
      // A lock already there means another handout of this run was handed
      // the same number a moment before. Ask the kernel for a fresh port.
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      continue;
    }
    if (!keepOpen) listener.close();
    let released = false;
    const claim = {
      port,
      release: () => {
        // The exit above may have taken this claim already, and a newer
        // owner may hold the filename then, so a claim releases once.
        if (released) return;
        released = true;
        heldLocks.delete(claim);
        Deno.removeSync(lockPath);
        if (keepOpen) listener.close();
      },
    };
    heldLocks.add(claim);
    return claim;
  }
  throw new Error(
    `All ${PORT_STEAL_TRIES} tries landed on a port another handout holds. Locks: ${heldPortDir}`,
  );
};

const withPort = async <T>(
  keepOpen: boolean,
  body: (port: number) => Promise<T> | T,
): Promise<T> => {
  const claimed = claimPort(keepOpen);
  try {
    return await body(claimed.port);
  } finally {
    claimed.release();
  }
};

export const withUnusedPort = <T>(
  body: (port: number) => Promise<T> | T,
): Promise<T> => withPort(false, body);

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

/**
 * Start once and say whether the port was taken by something else. Starting
 * finds anything already listening on the port and calls that a success,
 * which is not the question a failure test is asking.
 */
export const startFailedOrPortTaken = async (
  start: () => Promise<StartedStripeMock>,
  message?: string,
): Promise<boolean> => {
  let started: StartedStripeMock;
  try {
    started = await start();
  } catch (error) {
    if (message) says(String(error), message);
    return false;
  }
  // Outside the catch above, so a stop that goes wrong is not mistaken for
  // the start failing.
  await started.stop();
  return true;
};

/** Ask again while something else keeps taking the port we were handed.
 * `keptHappening` is read only once every try is spent, so a caller can
 * describe what it actually saw rather than what it expected to see. */
const retryWhilePortTaken = async (
  attempt: () => Promise<boolean>,
  keptHappening: () => string = () => "Starting stripe-mock kept succeeding",
): Promise<void> => {
  for (let tries = 0; tries < PORT_STEAL_TRIES; tries++) {
    if (!(await attempt())) return;
  }
  throw new Error(
    `${keptHappening()}: the port was taken ${PORT_STEAL_TRIES} times running.`,
  );
};

/**
 * Run the body on a fresh port, and start over while the body says the port
 * was taken. The handout holds the port it picks, so another handout of this
 * run cannot take it in between; the ask-again covers listeners from outside
 * the run's handouts. `keptHappening` is read only once every try is spent,
 * so a caller can describe what it actually saw rather than what it expected
 * to see.
 */
export const withFreshPortWhileTaken = (
  body: (port: number) => Promise<boolean>,
  keptHappening?: () => string,
): Promise<void> =>
  retryWhilePortTaken(() => withUnusedPort(body), keptHappening);

/**
 * A start that finds anything already listening has not failed for the
 * reason this test came for, so the answer asks again on a fresh port.
 */
export const expectStartFailsWith = (
  startOn: (port: number) => Promise<StartedStripeMock>,
  message?: string,
): Promise<void> =>
  withFreshPortWhileTaken((port) =>
    startFailedOrPortTaken(() => startOn(port), message),
  );

export const expectStartFails = (
  options: StartOptions,
  message?: string,
): Promise<void> =>
  expectStartFailsWith(
    (port) => startStripeMock({ ...options, port }),
    message,
  );

export const expectStripeMockFails = (
  options: StartOptions,
  message = STRIPE_MOCK_FAILED_TO_START,
): Promise<void> => expectStartFails(options, message);
