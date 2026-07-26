/**
 * A step that only finishes once every row is running.
 *
 * Each row writes its line, then waits for the other row's line to appear.
 * Two workers running side by side both see two lines and pass. One worker
 * running the rows one after another leaves the first row waiting for a line
 * that cannot arrive until it returns, so the wait gives up and the run
 * fails. That makes "these rows really did run at the same time" a fact the
 * test proves, rather than something inferred from how the clock happened to
 * fall on a busy machine.
 */

import { Given } from "@cucumber/cucumber";
import { requiredSpecRunsPath } from "./record-step.ts";

/** How many rows the outline fixture runs, so how many lines to wait for. */
export const CONCURRENT_ROWS = 2;

/** Give up rather than hang forever when the rows are not really concurrent. */
const WAIT_TIMEOUT_MS = 30_000;
const POLL_MS = 10;

/** How many rows have written their line so far. */
const linesWritten = async (path: string): Promise<number> =>
  (await Deno.readTextFile(path)).split("\n").filter(Boolean).length;

export interface WaitOptions {
  pollMs?: number;
  rows?: number;
  timeoutMs?: number;
}

/**
 * Wait until `rows` rows have written their line, or throw saying they did
 * not run at the same time.
 */
export const waitForRows = async (
  path: string,
  {
    pollMs = POLL_MS,
    rows = CONCURRENT_ROWS,
    timeoutMs = WAIT_TIMEOUT_MS,
  }: WaitOptions = {},
): Promise<void> => {
  const giveUpAt = Date.now() + timeoutMs;
  while ((await linesWritten(path)) < rows) {
    if (Date.now() > giveUpAt) {
      throw new Error(
        `Only ${await linesWritten(path)} of ${rows} rows started within the ` +
          "wait, so the rows did not run at the same time.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
};

export const registerConcurrentStep = (): void => {
  Given("a selected example runs", async () => {
    const path = requiredSpecRunsPath();
    await Deno.writeTextFile(path, "run\n", { append: true });
    await waitForRows(path);
  });
};
