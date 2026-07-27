/**
 * Finding a port to run a mock on, and saying what should happen when one is
 * started. Kept apart from the rest of the stripe-mock helpers because ports
 * are their own concern, with their own race to watch for.
 */

import { expect } from "@std/expect";
import {
  STRIPE_MOCK_FAILED_TO_START,
  startStripeMock,
} from "#scripts/stripe-mock.ts";
import type { StartOptions } from "#test/test-utils/stripe-mock/helpers.ts";

type StartedStripeMock = Awaited<ReturnType<typeof startStripeMock>>;

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

/** How many times a taken port is forgiven before the test is failed. */
export const PORT_STEAL_TRIES = 5;

/**
 * Start once and say whether the port was taken by something else. Starting
 * finds anything already listening on the port and calls that a success, which
 * is not the question a failure test is asking.
 */
export const startFailedOrPortTaken = async (
  start: () => Promise<StartedStripeMock>,
  message?: string,
): Promise<boolean> => {
  let started: StartedStripeMock;
  try {
    started = await start();
  } catch (error) {
    if (message) expect(String(error)).toContain(message);
    return false;
  }
  // Outside the catch above, so a stop that goes wrong is not mistaken for
  // the start failing.
  await started.stop();
  return true;
};

/** Ask again while something else keeps taking the port we were handed. */
export const retryWhilePortTaken = async (
  attempt: () => Promise<boolean>,
): Promise<void> => {
  for (let tries = 0; tries < PORT_STEAL_TRIES; tries++) {
    if (!(await attempt())) return;
  }
  throw new Error(
    `Starting stripe-mock kept succeeding: the port was taken ${PORT_STEAL_TRIES} times running.`,
  );
};

/**
 * A free port is picked and let go of before it is used, so another test
 * starting at that moment can take it. Ask again on a fresh port rather than
 * reading that as the failure this test came for.
 */
export const expectStartFails = (
  options: StartOptions,
  message?: string,
): Promise<void> =>
  retryWhilePortTaken(async () => {
    let portWasTaken = false;
    await withUnusedPort(async (port) => {
      portWasTaken = await startFailedOrPortTaken(
        () => startStripeMock({ ...options, port }),
        message,
      );
    });
    return portWasTaken;
  });

export const expectStripeMockFails = (
  options: StartOptions,
  message = STRIPE_MOCK_FAILED_TO_START,
): Promise<void> => expectStartFails(options, message);
