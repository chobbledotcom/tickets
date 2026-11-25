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
import {
  type CameraFakes,
  cameraFakes,
  postedScanBodies,
  scanFirst,
  seedTicketCache,
  start,
  whenStatusShows,
} from "./camera-fakes.ts";
import {
  DOOR_KEY,
  el,
  fullStore,
  queuedItem,
  SCAN_PATH,
  type ScannerGlobals,
  type ScannerHarness,
  storedQueue,
  TOKEN,
  whenTextShows,
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

/** The held ticket digest: release opens the gate, and disposing restores
 * the platform's own sign. */
export interface HeldTicketDigest {
  release: () => void;
  [Symbol.dispose]: () => void;
}

/** Holds the platform's ticket digest until the test opens the gate: the
 * scan's hmac then waits mid-flight, the way a slow device digests. Compute
 * every seed digest before the hold starts, or the seed waits on it too. */
const holdTicketDigest = (): HeldTicketDigest => {
  const gate = Promise.withResolvers<void>();
  const realSign = globalThis.crypto.subtle.sign.bind(globalThis.crypto.subtle);
  globalThis.crypto.subtle.sign = (async (
    algorithm: AlgorithmIdentifier,
    key: CryptoKey,
    data: BufferSource,
  ) => {
    await gate.promise;
    return realSign(algorithm, key, data);
  }) as typeof globalThis.crypto.subtle.sign;
  return {
    release: (): void => gate.resolve(),
    [Symbol.dispose]: (): void => {
      globalThis.crypto.subtle.sign = realSign;
    },
  };
};

/** Seeds the door's cache with the token's digest, holds the platform's
 * digest so the scan waits mid-hmac, opens the camera, and decodes the
 * token once. The scan waits on the gate the test opens. */
export const scanWaitingOnDigest = async (
  h: ScannerHarness,
  fakes: CameraFakes,
  token: string,
): Promise<HeldTicketDigest> => {
  await seedTicketCache(h, token, Date.now());
  const digest = holdTicketDigest();
  await start(h);
  await scanFirst(fakes, token);
  return digest;
};

/** One offline scan: the camera opens with the door's cache holding the
 * given ticket — or, when `cache` is null, with nothing seeded — and the
 * first decode reaches the page. */
export const scanOffline = async (
  h: ScannerHarness,
  scanned: string,
  cache: { token?: string; storedAt?: number } | null = {},
): Promise<void> => {
  using fakes = cameraFakes(h);
  fakes.ready(4);
  if (cache !== null) {
    await seedTicketCache(
      h,
      cache.token ?? scanned,
      cache.storedAt ?? Date.now(),
    );
  }
  await start(h);
  await scanFirst(fakes, scanned);
};

/** An armed switch on a device whose store refuses writes: the click changes
 * nothing, and the page says why. The mode stays stored, the banner stays
 * up, and the switch reads as pressed. */
export const expectSwitchRefused = async (h: ScannerHarness): Promise<void> => {
  fullStore(h);
  el(h.document, "scanner-offline-toggle").click();

  await whenTextShows(
    h.statusEl,
    "Your change was not saved. Free up space on this device, then try again.",
  );
  expect(h.statusEl.className).toContain("scanner-status-error");
  expect(h.window.localStorage.getItem("scanner-offline-mode")).toBe("1");
  expect(el(h.document, "scanner-offline-banner").className).not.toContain(
    "hidden",
  );
  expect(
    el(h.document, "scanner-offline-toggle").getAttribute("aria-pressed"),
  ).toBe("true");
};

/** One offline scan of a booking the saved list says owes three places.
 * The ask is on the page when this settles; the caller answers it. */
export const scanPartyOfThree = async (h: ScannerHarness): Promise<void> => {
  using fakes = cameraFakes(h);
  fakes.ready(4);
  await seedTicketCache(h, TOKEN, Date.now(), 3);
  await start(h);
  await scanFirst(fakes, TOKEN);
  // The digest runs on the platform's own crypto promise, so the ask shows
  // over real event-loop turns.
  await whenStatusShows(
    el(h.document, "scanner-quantity-message"),
    "How many people are you checking in?",
  );
};

/** A door that cancels the quantity ask queues nothing and is told so. */
export const expectCancelQueuesNothing = async (
  h: ScannerHarness,
): Promise<void> => {
  await scanPartyOfThree(h);
  el(h.document, "scanner-quantity-cancel").click();

  await whenStatusShows(
    h.statusEl,
    "Nothing was queued. Scan the ticket again to check them in.",
  );
  expect(h.statusEl.className).toContain("scanner-status-warning");
  expect(storedQueue(h)).toBe(null);
};
