/** Shared harness for the served-door browser contracts: one seeded group
 * door with a party of three on one ticket, and the door's page opened on
 * the app's own loopback server in a fresh signed-in context. The page is
 * the route handler's own output and the script is the built scanner bundle,
 * so the words asserted are the words the door reads. The camera is a canvas
 * that shows the real QR the ticket page encodes, so each scan walks the
 * camera loop and its real decoder. The scan endpoint stays the app's own
 * route behind a tap that reads each delivery and lets it through, so a
 * journey asserts what the page sends while the door answers for real. The
 * service worker stays out of the way: its serving contract is the
 * scanner-sw suite's subject, and a blocked worker leaves these journeys
 * unchanged. The page-word readers live in `offline-door-page.ts`.
 *
 * Runs under `deno task test:screenshot-contract` (Chromium required), never
 * in the main suite. The task builds the bundle the served page loads, so no
 * bundler process runs inside a test.
 */

import { expect } from "@std/expect";
import type { Page } from "playwright";
import { encode } from "uqr";
import * as v from "valibot";
import type { TicketCacheEntry } from "#routes/admin/scan-cache.ts";
import { buildCheckinUrl } from "#shared/ticket-url.ts";
import {
  type BrowserContract,
  testOwnerCookiePair,
} from "#test-utils/browser-contract.ts";
import { bookTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { storedCheckinRows } from "#test-utils/db-helpers/checkin-rows.ts";
import { createGroupWithListings } from "#test-utils/db-helpers/groups.ts";
import type { Attendee, Group } from "#types";

declare global {
  interface Window {
    /** The fake camera's frame swapper, which the init script installs. */
    showTicket?: (who: string) => Promise<void>;
  }
}

/** A ticket the door's list does not hold: any well-formed token no booking
 * carries. */
export const UNKNOWN = "unknown-visitor-token";

/** The places the seeded booking owed when the list was built, so a scan
 * asks, and the door checks in two of the three. */
export const HELD_PLACES = 3;
export const CHECK_IN_PICK = 2;

/** The ticket list one door's cache endpoint answers and the page stores:
 * one keyed digest per ticket, with the places one scan at the door admits.
 * Both boundaries are outside the test's own code, so both parse. */
const cacheEntriesSchema = v.array(
  v.object({ hash: v.string(), tickets: v.pipe(v.number(), v.integer()) }),
);
const servedCacheSchema = v.object({ entries: cacheEntriesSchema });
const storedCacheSchema = v.object({
  entries: cacheEntriesSchema,
  storedAt: v.number(),
});

/** One seeded door: the group and its one listing, the person whose ticket
 * the door's list holds, and the paths the page and its store key read. */
export interface SeededDoor {
  attendee: Attendee;
  cacheStoreKey: string;
  group: Group;
  listing: { id: number; name: string };
  pagePath: string;
  scanPath: string;
}

export const seedDoor = async (
  groupName: string,
  listingName: string,
): Promise<SeededDoor> => {
  const { group, listings } = await createGroupWithListings(groupName, [
    listingName,
  ]);
  const listing = listings[0]!;
  const attendee = await bookTestAttendee(
    [{ listingId: listing.id, quantity: HELD_PLACES }],
    "Ada",
    "ada@example.com",
  );
  const scanPath = `/admin/groups/${group.id}/scan`;
  return {
    attendee,
    cacheStoreKey: `scanner-tickets-${scanPath}`,
    group,
    listing,
    pagePath: `/admin/groups/${group.id}/scanner`,
    scanPath,
  };
};

/** One ticket's QR as the camera canvas paints it: the dark modules of the
 * matrix the ticket page's own encoder produces for the check-in link. */
interface TicketQr {
  dark: [number, number][];
  size: number;
}

const ticketQr = (token: string): TicketQr => {
  const qr = encode(buildCheckinUrl(token));
  const dark: [number, number][] = [];
  for (const [y, row] of qr.data.entries()) {
    for (const [x, on] of row.entries()) {
      if (on) dark.push([x, y]);
    }
  }
  return { dark, size: qr.size };
};

/** What one door page opens with: its page, its recorded deliveries, and
 * the one close that shuts the journey's own context. */
export interface OpenDoor {
  close: () => Promise<void>;
  /** The bodies the door's scan endpoint received, in send order. */
  deliveries: Record<string, unknown>[];
  page: Page;
}

/** One door page on the contract's own server: fresh store, no service
 * worker, and the context closes inside the journey that opened it. The
 * camera init script runs before the bundle, so the loop meets the fake
 * stream, and it paints the first ticket the record holds. */
export const openDoor = async (
  contract: BrowserContract,
  door: SeededDoor,
  tickets: Record<string, string>,
): Promise<OpenDoor> => {
  const context = await contract.browser.newContext({
    baseURL: contract.baseUrl,
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  const [name, value] = await testOwnerCookiePair();
  await context.addCookies([{ name, url: contract.baseUrl, value }]);
  const page = await context.newPage();
  // The journey's tickets paint in the order the record holds them, and the
  // unknown ticket comes last, so the camera's first frame is the ticket the
  // first scan expects.
  const qr = {
    ...tickets,
    unknown: UNKNOWN,
  };
  await page.addInitScript(
    (codes: Record<string, TicketQr>) => {
      // No guard for a missing mediaDevices: the assignment below throws,
      // and a broken fake camera must be loud, not a real camera path.
      const canvas = document.createElement("canvas");
      canvas.width = 400;
      canvas.height = 400;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("The fake camera canvas has no 2d context");
      const paint = (code: TicketQr): void => {
        const scale = Math.floor(320 / code.size);
        const left = Math.floor((canvas.width - scale * code.size) / 2);
        const top = Math.floor((canvas.height - scale * code.size) / 2);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#000000";
        for (const [x, y] of code.dark) {
          ctx.fillRect(left + x * scale, top + y * scale, scale, scale);
        }
      };
      const first = Object.values(codes)[0];
      if (!first) throw new Error("The fake camera carries no ticket");
      navigator.mediaDevices.getUserMedia = async () => {
        const stream = canvas.captureStream();
        paint(first);
        return stream;
      };
      window.showTicket = async (who) => {
        const code = codes[who];
        if (!code) throw new Error(`The fake camera carries no ${who} frame`);
        paint(code);
        // The next captured frame carries the new code.
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 250);
        await promise;
      };
    },
    Object.fromEntries(
      Object.entries(qr).map(([who, token]) => [who, ticketQr(token)]),
    ),
  );
  // The scan endpoint stays the app's own route: the tap reads each body and
  // lets the request through, so the door answers for real.
  const deliveries: Record<string, unknown>[] = [];
  await page.route(
    new URL(door.scanPath, contract.baseUrl).href,
    async (route) => {
      const raw = await route.request().postData();
      if (raw === null) throw new Error("The scan endpoint received no body");
      deliveries.push(
        v.parse(v.record(v.string(), v.unknown()), JSON.parse(raw)),
      );
      await route.continue();
    },
  );
  await page.goto(door.pagePath);
  return {
    close: () => context.close(),
    deliveries,
    page,
  };
};

/** Waits for the door's ticket list to be in the store. The page fetches it
 * while the connection holds, and a drop that lands first aborts that fetch,
 * so every journey waits here before it takes the connection away. */
export const waitDoorCacheStored = async (
  page: Page,
  door: SeededDoor,
): Promise<void> => {
  try {
    await page.waitForFunction(
      (key) => localStorage.getItem(key) !== null,
      door.cacheStoreKey,
      { timeout: 20_000 },
    );
  } catch (error) {
    const state = await page
      .evaluate(() => ({
        keys: Object.keys(localStorage),
        ready: document.readyState,
        url: location.href,
      }))
      .catch(() => ({ keys: [], ready: "?", url: "gone" }));
    throw new Error(
      `The door's ticket list never stored. url=${state.url} readyState=${state.ready} storeKeys=${JSON.stringify(state.keys)} door=${door.cacheStoreKey}`,
      { cause: error },
    );
  }
};

/** The ticket list the page's store holds, exactly as the cache endpoint
 * served it: the journeys read their digests from the two ends instead of
 * deriving one again. */
export const storedCacheEntries = async (
  page: Page,
  door: SeededDoor,
): Promise<TicketCacheEntry[]> => {
  const raw = await page.evaluate((key) => {
    const value = localStorage.getItem(key);
    if (value === null) throw new Error(`The door's store holds no ${key}`);
    return value;
  }, door.cacheStoreKey);
  return v.parse(storedCacheSchema, JSON.parse(raw)).entries;
};

/** The digest list the cache endpoint answers this session. */
export const servedCacheEntries = async (
  contract: BrowserContract,
  door: SeededDoor,
): Promise<TicketCacheEntry[]> => {
  const [name, value] = await testOwnerCookiePair();
  const response = await fetch(
    `${contract.baseUrl}/admin/groups/${door.group.id}/scan-cache`,
    { headers: { cookie: `${name}=${value}` } },
  );
  if (!response.ok) {
    throw new Error(`The scan-cache endpoint answered ${response.status}`);
  }
  return v.parse(servedCacheSchema, await response.json()).entries;
};

/** The body one queued delivery sends: its own operation id, the people the
 * door picked, and the digest the page stored. */
export const deliveryBody = v.object({
  operation_id: v.pipe(v.string(), v.nonEmpty()),
  quantity: v.pipe(v.number(), v.integer()),
  token_hash: v.pipe(v.string(), v.nonEmpty()),
});

/** Asserts the check-in state stored for the seeded booking: one line on
 * one listing, with `admitted` of its places checked in. */
export const checkRowsShow = async (
  attendeeId: number,
  admitted: number,
): Promise<void> => {
  const rows = await storedCheckinRows(attendeeId);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.checked_in).toBe(admitted);
};
