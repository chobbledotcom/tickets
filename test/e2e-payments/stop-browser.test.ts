/** Direct tests for the bounded browser shutdown. A fake browser answers
 * every path the real harness can hit, so each branch runs without a real
 * Chromium. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { Browser, CDPSession } from "playwright";
import { stopScratchBrowser } from "#e2e/stop-browser.ts";

/** A fake browser that answers the three ways the shutdown asks of it. `close`
 * is a promise the test settles; the connection flag and the CDP answers are
 * set up front. */
const fakeBrowser = (setup: {
  cdpsession?: CDPSession | null;
  connected?: () => boolean;
  close?: Promise<void>;
}): Browser =>
  ({
    close: () => setup.close ?? Promise.resolve(),
    isConnected: () => setup.connected?.() ?? false,
    newBrowserCDPSession: () =>
      setup.cdpsession === undefined
        ? Promise.reject(new Error("no session"))
        : Promise.resolve(setup.cdpsession),
  }) as unknown as Browser;

describe("stopScratchBrowser", () => {
  test("does nothing loud when the graceful close disconnects", async () => {
    await stopScratchBrowser(fakeBrowser({ connected: () => false }));
  });

  test("stays quiet when the graceful close itself fails", async () => {
    // A dead connection cannot answer the graceful close, so the bound maps
    // the failure to nothing settled and the run stays quiet.
    await stopScratchBrowser(
      fakeBrowser({
        close: Promise.reject(new Error("already dead")),
        connected: () => false,
      }),
    );
  });

  test("forces the CDP close when the browser stays connected", async () => {
    const sent: string[] = [];
    let cdpAsked = false;
    const cdp = {
      send: (method: string) => {
        cdpAsked = true;
        sent.push(method);
        return Promise.resolve();
      },
    };
    await stopScratchBrowser(
      fakeBrowser({
        cdpsession: cdp as unknown as CDPSession,
        // The browser reports itself connected until the CDP ask lands.
        connected: () => !cdpAsked,
      }),
    );
    expect(sent).toEqual(["Browser.close"]);
  });

  test("throws when the browser survives both bounds", async () => {
    const cdp = { send: () => Promise.resolve() };
    await expect(
      stopScratchBrowser(
        fakeBrowser({
          cdpsession: cdp as unknown as CDPSession,
          connected: () => true,
        }),
      ),
    ).rejects.toThrow("Chromium did not close");
  });

  test("does not ask CDP at all when session creation fails", async () => {
    await expect(
      stopScratchBrowser(
        fakeBrowser({
          cdpsession: null,
          connected: () => true,
        }),
      ),
    ).rejects.toThrow("Chromium did not close");
  });
});
