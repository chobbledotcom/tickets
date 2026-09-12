/**
 * Close a scenario's scratch browser for good. The app under test is the
 * thing that must shut down cleanly, not this browser.
 */

import type { Browser } from "playwright";

/** A bounded wait, then a bounded CDP ask, then a loud failure. */
export const stopScratchBrowser = async (browser: Browser): Promise<void> => {
  // A frame-idle renderer can make graceful close hang, so bound it. When
  // the graceful close really will not finish, ask the browser itself to
  // exit over CDP (also bounded).
  await Promise.race([
    browser.close(),
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ]).catch(() => {
    // The close lost the race; the CDP path below is the fallback.
  });
  if (browser.isConnected()) {
    const cdp = await browser.newBrowserCDPSession().catch(() => null);
    await Promise.race([
      cdp?.send("Browser.close").catch(() => {
        // The browser process may already be gone.
      }),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
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
