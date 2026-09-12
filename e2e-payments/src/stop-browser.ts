/**
 * Close a scenario's scratch browser for good. The app under test is the
 * thing that must shut down cleanly, not this browser. Every wait is bounded,
 * and a bound's losing timer is cleared so it cannot hold the run open.
 */

import type { Browser } from "playwright";

/** The losing timer of one bounded wait, cleared once the wait settles. */
const bounded = async <T>(wait: Promise<T>, ms: number): Promise<T | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    return await Promise.race([
      wait.then(
        (value) => value,
        () => null,
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/** A bounded graceful close, then a bounded CDP ask, then a loud failure. */
export const stopScratchBrowser = async (browser: Browser): Promise<void> => {
  // A frame-idle renderer can make graceful close hang, so bound it. When
  // the graceful close really will not finish, ask the browser itself to
  // exit over CDP (also bounded).
  await bounded(browser.close(), 10_000);
  if (browser.isConnected()) {
    // The session can hang the same way the close can, so bound it too:
    // a session that never opens must not keep the Browser.close ask from
    // running.
    const cdp = await bounded(browser.newBrowserCDPSession(), 5_000);
    if (cdp !== null) await bounded(cdp.send("Browser.close"), 5_000);
    if (browser.isConnected()) {
      // Playwright exposes no process handle to kill, so a surviving
      // browser is raised: the cleanup sweep fails the scenario rather
      // than leave a zombie Chromium on the runner.
      throw new Error(
        "Chromium did not close after the bounded graceful close and CDP Browser.close",
      );
    }
  }
};
