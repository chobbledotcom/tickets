/// <reference lib="dom" />

/**
 * The offline door's shared test helpers: the queue panel's readers, the
 * store seeds, and the fetch stub's accounting. The door's queue, sync, and
 * race suites drive the same built bundle, so they read the panel and the
 * store the same way.
 */

import { expect } from "@std/expect";
import type { Stub } from "@std/testing/mock";
import type { HTMLElement as HappyHTMLElement } from "happy-dom";
import { postedScanTokens, whenStatusShows } from "./camera-fakes.ts";
import {
  el,
  queuedItem,
  SCAN_PATH,
  type ScannerGlobals,
  type ScannerHarness,
  storedQueue,
} from "./fixture.ts";

/** Every fetch the page made, as the urls it asked for. */
export const askedUrls = (fetchStub: Stub): string[] =>
  fetchStub.calls.map((call) => String(call.args[0]));

/** The store holds exactly one queued check-in, the token the page kept. */
export const expectOneStoredCheckIn = (
  h: ScannerHarness,
  token: string,
): void => {
  expect(JSON.parse(String(storedQueue(h)))).toEqual([
    { queuedAt: expect.any(Number), scanPath: SCAN_PATH, token },
  ]);
};

/** What one offline refusal leaves: the wording on the page, the error
 * status, nothing stored, and no request beyond the page load's cache
 * refresh. */
export const expectOfflineRefusal = async (
  h: ScannerHarness,
  fetchStub: Stub,
  message: string,
): Promise<void> => {
  await whenStatusShows(h.statusEl, message);
  expect(h.statusEl.className).toContain("scanner-status-error");
  expect(storedQueue(h)).toBe(null);
  expect(askedUrls(fetchStub)).toEqual([`${SCAN_PATH}-cache`]);
};

/** The queue panel's first row, which every sync test's page carries. */
export const firstRow = (h: ScannerHarness) => {
  const row = el(h.document, "scanner-queue-items").children[0];
  if (!row) throw new Error("The queue panel carries no first row");
  return row;
};

/** Every row the queue panel carries, as the words it shows. */
export const rowWords = (h: ScannerHarness): (string | null)[] =>
  [...el(h.document, "scanner-queue-items").children].map(
    (row) => row.textContent,
  );

/** The page globals one queued check-in seeds, for the tests that replay
 * the queue. */
export const queueSeeded = (): ScannerGlobals => ({
  seed: (store) => store.setItem("scanner-queue", JSON.stringify([queuedItem])),
});

/** What one settled sync leaves: the done words, the store empty, the
 * panel count at zero, and the check-ins the door received, in order. */
export const expectSyncSettled = async (
  h: ScannerHarness,
  wait: (target: HappyHTMLElement, text: string) => Promise<void>,
  fetchStub: Stub,
  postedTokens: string[],
): Promise<void> => {
  await wait(h.statusEl, "Queued tickets are done.");
  expect(storedQueue(h)).toBe("[]");
  expect(el(h.document, "scanner-queue-summary").textContent).toBe(
    "0 queued check-ins",
  );
  expect(postedScanTokens(fetchStub)).toEqual(postedTokens);
};

/** The queued check-ins one reload settles, oldest first. */
export const queuedItems = (tokens: string[]): string =>
  JSON.stringify(
    tokens.map((token, index) => ({
      queuedAt: index + 1,
      scanPath: SCAN_PATH,
      token,
    })),
  );

/** The door's answer one settled queue replay gets. A fresh response per
 * call: the page load's cache refresh consumes the first one's body, and a
 * reused body would fail the replay's read. */
export const settledCheckIn = (): Response =>
  Response.json({
    listingName: "Standard",
    name: "Ada",
    quantity: 1,
    status: "checked_in",
    total: 1,
  });
