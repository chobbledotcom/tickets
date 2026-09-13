import type { Browser } from "playwright";

type Outcome<T> =
  | { kind: "completed"; value: T }
  | { kind: "failed" }
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
      (): Outcome<T> => ({ kind: "failed" }),
    );
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/** Playwright exposes no process handle.
 * A browser that survives must fail cleanup. */
export const stopScratchBrowser = async (browser: Browser): Promise<void> => {
  await bounded(browser.close(), 10_000);
  if (browser.isConnected()) {
    const cdp = await bounded(browser.newBrowserCDPSession(), 5_000);
    if (cdp.kind === "completed" && browser.isConnected()) {
      await bounded(cdp.value.send("Browser.close"), 5_000);
    }
    if (browser.isConnected()) {
      throw new Error(
        "Chromium did not close after the bounded graceful close and CDP Browser.close",
      );
    }
  }
};
