import type { Browser } from "playwright";

type Outcome<T> =
  | { kind: "completed"; value: T }
  | { kind: "failed"; reason: unknown }
  | { kind: "timed-out" };

const bounded = async <T>(
  wait: Promise<T>,
  ms: number,
): Promise<Outcome<T>> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Outcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timed-out" }), ms);
  });
  try {
    // Keep the rejection handler attached even after the deadline wins.
    const operation = wait.then(
      (value): Outcome<T> => ({ kind: "completed", value }),
      (reason): Outcome<T> => ({ kind: "failed", reason }),
    );
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/** What a failed graceful close said, for the error that reports it. */
const closeSaid = (graceful: Outcome<unknown>): string => {
  if (graceful.kind !== "failed") return "";
  const message =
    graceful.reason instanceof Error
      ? graceful.reason.message
      : String(graceful.reason);
  return ` (the graceful close said: ${message})`;
};

/** Playwright exposes no process handle.
 * A browser that survives must fail cleanup. */
export const stopScratchBrowser = async (browser: Browser): Promise<void> => {
  const graceful = await bounded(browser.close(), 10_000);
  if (browser.isConnected()) {
    const cdp = await bounded(browser.newBrowserCDPSession(), 5_000);
    if (cdp.kind === "completed" && browser.isConnected()) {
      await bounded(cdp.value.send("Browser.close"), 5_000);
    }
    if (browser.isConnected()) {
      throw new Error(
        `Chromium did not close after the bounded graceful close and CDP Browser.close${closeSaid(graceful)}`,
      );
    }
  }
};
