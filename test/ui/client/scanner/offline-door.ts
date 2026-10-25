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
import { hmacHex } from "#shared/sha256.ts";
import { postedScanBodies, whenStatusShows } from "./camera-fakes.ts";
import {
  DOOR_KEY,
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

/** The digest the door's list holds for one token, under the fixture page's
 * key: what the page stores, queues, and posts. */
export const digestOf = (token: string): Promise<string> =>
  hmacHex(DOOR_KEY, token);

/** The store holds exactly one queued check-in: the digest the scan stored,
 * the delivery id it made up, and the one person it admits. */
export const expectOneStoredCheckIn = async (
  h: ScannerHarness,
  token: string,
): Promise<void> => {
  expect(JSON.parse(String(storedQueue(h)))).toEqual([
    {
      operationId: expect.any(String),
      quantity: 1,
      queuedAt: expect.any(Number),
      scanPath: SCAN_PATH,
      tokenHash: await digestOf(token),
    },
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
 * panel count at zero, and the deliveries the door received, in order —
 * each named by the ticket digest it carried. */
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
  const digests = await Promise.all(postedTokens.map(digestOf));
  expect(postedDeliveryHashes(fetchStub)).toEqual(digests);
};

/** The ticket digests one sync's deliveries carried, in the order the door
 * received them. */
export const postedDeliveryHashes = (fetchStub: Stub): string[] =>
  postedScanBodies(fetchStub).map((body) => body.token_hash as string);

/** The queued check-ins one reload settles, oldest first: each names the
 * digest its scan stored, the delivery id it answers by, and the people it
 * admits. Each went in a second apart, so the door's replay window still
 * covers them all. */
export const queuedItems = async (tokens: string[]): Promise<string> =>
  JSON.stringify(
    await Promise.all(
      tokens.map(async (token, index) => ({
        operationId: `018f3c2e-1b7d-7f31-9d4a-2f5c8e6a9b3${index}`,
        quantity: 1,
        queuedAt: Date.now() - (tokens.length - index) * 1000,
        scanPath: SCAN_PATH,
        tokenHash: await digestOf(token),
      })),
    ),
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
