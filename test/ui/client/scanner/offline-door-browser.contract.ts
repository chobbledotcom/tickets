/**
 * Browser contract for the offline door on the served scanner page.
 *
 * The page is the template's rendered output and the script is the built
 * scanner bundle, so the words asserted are the words the door reads. The
 * camera is a canvas that shows the real QR the ticket page encodes, so each
 * scan walks the camera loop and its real decoder. The cache endpoint
 * answers the keyed digests the real endpoint answers. The scan endpoint
 * answers the real check-in shape and counts the check-ins it was sent. The
 * connection drop and return use the browser's own network emulation. The
 * service worker stays out of the way: its serving contract is the
 * scanner-sw suite's subject, and a blocked worker leaves this journey
 * unchanged.
 *
 * Runs under `deno task test:screenshot-contract` (Chromium required), never
 * in the main suite. The task builds the bundle this file reads, so no
 * bundler process runs inside the test.
 */

import { expect } from "@std/expect";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  it as test,
} from "@std/testing/bdd";
import { type Browser, chromium, type Page } from "playwright";
import { encode } from "uqr";
import { fromBase64Url } from "#crypto/utils.ts";
import { ensureMessageGroups, t } from "#i18n";
import { doorCacheName, pageDoorCacheKey } from "#routes/admin/scan-cache.ts";
import { browserLaunchOptions } from "#scripts/browser-options.ts";
import { chromiumExecutable } from "#scripts/screenshots/browser.ts";
import { hmacHex } from "#shared/sha256.ts";
import { buildCheckinUrl } from "#shared/ticket-url.ts";
import { adminScannerPage } from "#templates/admin/scanner.tsx";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";

declare global {
  interface Window {
    /** The fake camera's frame swapper, which the init script installs. */
    showTicket?: (ticket: "held" | "unknown") => Promise<void>;
  }
}

const PAGE_PATH = "/admin/groups/5/scanner";
const SCAN_PATH = "/admin/groups/5/scan";
const CACHE_PATH = "/admin/groups/5/scan-cache";
const DOOR = doorCacheName("group", 5);

/** The ticket the door's list holds, and one it does not. The held booking
 * owed three places when the list was built, so the scan asks, and the
 * door checks in two of the three. */
const HELD = "held-ada-token-01";
const UNKNOWN = "unknown-visitor-token";
const HELD_PLACES = 3;
const CHECK_IN_PICK = 2;

/** The check-in answer the door's scan endpoint sends, in its own shape. */
const CHECKED_IN = {
  listingName: "Ceilidh",
  name: "Ada",
  quantity: 1,
  status: "checked_in",
  total: 1,
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

describe("the offline door on the served scanner page", () => {
  let browser: Browser;
  let bundle: string;
  /** The delivery bodies the scan endpoint received. */
  let deliveries: Record<string, unknown>[];
  let hashes: string[];
  let pageHtml: string;
  /** The answer the scan endpoint gives the next delivery. */
  let scanAnswer: Record<string, unknown>;

  beforeAll(async () => {
    // The raw contract task runs without the test harness's preload, so the
    // copy the page and the assertions read is loaded here: the scanner's
    // own group, and the groups the page shell reads.
    await ensureMessageGroups(["check-in", "common", "nav", "nouns"]);
    await setupAdminPageTest();
    bundle = await Deno.readTextFile("src/ui/static/scanner.js");

    // The ticket list the real cache endpoint serves for this door: the
    // held ticket's token digested under the key the page alone carries,
    // with the places its booking owed when the list was built.
    const doorKey = fromBase64Url(pageDoorCacheKey(DOOR));
    hashes = [await hmacHex(doorKey, HELD)];
    pageHtml = adminScannerPage(
      { name: "Ceilidh" },
      SCAN_PATH,
      { adminLevel: "scanner" },
      [],
      false,
      pageDoorCacheKey(DOOR),
    );

    browser = await chromium.launch(
      browserLaunchOptions(true, await chromiumExecutable()),
    );
  });

  afterAll(async () => {
    await browser.close();
  });

  beforeEach(() => {
    deliveries = [];
    scanAnswer = CHECKED_IN;
  });

  const serveDoor = async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === PAGE_PATH) {
      return new Response(pageHtml, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (request.method === "GET" && path === "/scanner.js") {
      return new Response(bundle, {
        headers: { "content-type": "text/javascript" },
      });
    }
    if (request.method === "GET" && path === CACHE_PATH) {
      return Response.json({
        entries: hashes.map((hash) => ({ hash, tickets: HELD_PLACES })),
      });
    }
    if (request.method === "POST" && path === SCAN_PATH) {
      deliveries.push(await request.json());
      return Response.json(scanAnswer);
    }
    return new Response(null, { status: 404 });
  };

  /** One door page with its own server: fresh store, no service worker, and
   * every resource the journey opens closes inside the journey's own test.
   * The camera init script runs before the bundle, so the loop meets the fake
   * stream. The blank page the browser opens first carries no mediaDevices. */
  const openDoor = async (): Promise<{
    page: Page;
    server: Deno.HttpServer;
  }> => {
    const server = Deno.serve({ hostname: "127.0.0.1", port: 0 }, (request) =>
      serveDoor(request),
    );
    if (server.addr.transport !== "tcp") {
      throw new Error("Browser contract server did not open a TCP port");
    }
    const page = await browser.newPage({ serviceWorkers: "block" });
    await page.addInitScript(
      (qr: { held: TicketQr; unknown: TicketQr }) => {
        if (!navigator.mediaDevices) return;
        const canvas = document.createElement("canvas");
        canvas.width = 400;
        canvas.height = 400;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("The fake camera canvas has no 2d context");
        const paint = (qr: TicketQr): void => {
          const scale = Math.floor(320 / qr.size);
          const left = Math.floor((canvas.width - scale * qr.size) / 2);
          const top = Math.floor((canvas.height - scale * qr.size) / 2);
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = "#000000";
          for (const [x, y] of qr.dark) {
            ctx.fillRect(left + x * scale, top + y * scale, scale, scale);
          }
        };
        navigator.mediaDevices.getUserMedia = async () => {
          const stream = canvas.captureStream();
          paint(qr.held);
          return stream;
        };
        window.showTicket = async (ticket) => {
          paint(ticket === "unknown" ? qr.unknown : qr.held);
          // The next captured frame carries the new code.
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, 250);
          await promise;
        };
      },
      { held: ticketQr(HELD), unknown: ticketQr(UNKNOWN) },
    );
    await page.goto(`http://127.0.0.1:${server.addr.port}${PAGE_PATH}`);
    return { page, server };
  };

  const textOf = (page: Page, id: string): Promise<string> =>
    page.evaluate((elementId) => {
      const found = document.getElementById(elementId);
      if (!found) throw new Error(`The served page carries no ${elementId}`);
      return found.textContent;
    }, id);

  /** Waits for the element to carry the text. A page that lost the element
   * fails at once, the way a broken page must. */
  const waitText = async (
    page: Page,
    id: string,
    text: string,
  ): Promise<void> => {
    await page.waitForFunction(
      ({ elementId, text }: { elementId: string; text: string }) => {
        const found = document.getElementById(elementId);
        if (!found) throw new Error(`The served page carries no ${elementId}`);
        return found.textContent === text;
      },
      { elementId: id, text },
      { timeout: 20_000 },
    );
  };

  const statusShows = (page: Page, text: string): Promise<void> =>
    waitText(page, "scanner-status", text);

  const bannerText = (page: Page): Promise<string> =>
    textOf(page, "scanner-offline-banner-text");

  const bannerHidden = (page: Page): Promise<boolean> =>
    page.evaluate(() => {
      const banner = document.getElementById("scanner-offline-banner");
      if (!banner) {
        throw new Error("The served page carries no scanner-offline-banner");
      }
      return banner.classList.contains("hidden");
    });

  const queuePanelHidden = (page: Page): Promise<boolean> =>
    page.evaluate(() => {
      const panel = document.getElementById("scanner-queue");
      if (!panel) throw new Error("The served page carries no scanner-queue");
      return panel.classList.contains("hidden");
    });

  const queueSummary = (page: Page): Promise<string> =>
    textOf(page, "scanner-queue-summary");

  const firstQueueRow = (
    page: Page,
  ): Promise<{ className: string; text: string }> =>
    page.evaluate(() => {
      const list = document.getElementById("scanner-queue-items");
      if (!list) {
        throw new Error("The served page carries no scanner-queue-items");
      }
      const row = list.children[0];
      if (!row) throw new Error("The queue panel carries no first row");
      return { className: row.className, text: row.textContent ?? "" };
    });

  const togglePressed = (page: Page): Promise<string> =>
    page.evaluate(() => {
      const toggle = document.getElementById("scanner-offline-toggle");
      if (!toggle) {
        throw new Error("The served page carries no scanner-offline-toggle");
      }
      const pressed = toggle.getAttribute("aria-pressed");
      if (pressed === null) {
        throw new Error("The toggle carries no pressed state");
      }
      return pressed;
    });

  /** Drops and restores the connection. The network emulation makes every
   * real fetch fail. Chromium's emulation does not reach the renderer's
   * connection state, so the test hands the page the state the network now
   * holds, the way the browser hands it over: the onLine value and the
   * state's own event. */
  const setConnection = async (page: Page, online: boolean): Promise<void> => {
    await page.context().setOffline(!online);
    await page.evaluate((state) => {
      Object.defineProperty(navigator, "onLine", {
        configurable: true,
        get: () => state,
      });
      window.dispatchEvent(new Event(state ? "online" : "offline"));
    }, online);
  };

  const swapFrame = (page: Page, ticket: "held" | "unknown"): Promise<void> =>
    page.evaluate((which) => {
      if (!window.showTicket) {
        throw new Error("The fake camera carries no frame swapper");
      }
      return window.showTicket(which);
    }, ticket);

  /** Scans the ticket in the camera's frame and asserts what the door sees:
   * the ask names how many people the check-in admits, the door checks in
   * two of the booking's three, and the queued words, one waiting row, one
   * pending check-in, and no request sent. */
  const scanWaitsInQueue = async (page: Page): Promise<void> => {
    const sentBefore = deliveries.length;
    await page.click("#scanner-start");
    await waitText(
      page,
      "scanner-quantity-message",
      t("admin.scanner.offline_quantity_ask"),
    );
    // The whole party is the common case, so it starts selected. The door
    // checks in two of the three.
    await page.selectOption("#scanner-quantity-select", String(CHECK_IN_PICK));
    await page.click("#scanner-quantity-confirm");
    await statusShows(page, t("admin.scanner.offline_queued"));
    expect((await firstQueueRow(page)).text).toBe(
      t("admin.scanner.queue_item_queued"),
    );
    expect(await queueSummary(page)).toBe(
      t("admin.scanner.queue_count_one", { count: 1 }),
    );
    expect(deliveries.length).toBe(sentBefore);
  };

  /** Restores the connection and asserts the sync's outcome: one delivery
   * sent with the digest the page stored, its own operation id, and the
   * people the door picked; the row the answer settled on, and the queue
   * emptied. */
  const syncChecksTheScanIn = async (
    page: Page,
    row: { className: string; text: string } = {
      className: "",
      text: t("admin.scanner.queue_item_checked_in"),
    },
  ): Promise<void> => {
    const sentBefore = deliveries.length;
    await setConnection(page, true);
    await statusShows(page, t("admin.scanner.sync_done"));
    // One delivery this sync: the queued check-in's own body, with its own
    // operation id and the people the door picked.
    expect(deliveries.length).toBe(sentBefore + 1);
    expect(deliveries.at(-1)).toEqual({
      operation_id: expect.any(String),
      quantity: CHECK_IN_PICK,
      token_hash: hashes[0],
    });
    expect(await firstQueueRow(page)).toEqual(row);
    expect(await queueSummary(page)).toBe(
      t("admin.scanner.queue_count_other", { count: 0 }),
    );
    expect(
      await page.evaluate(() => localStorage.getItem("scanner-queue")),
    ).toBe("[]");
  };

  /** The replay answer one over-admitted delivery lands with, and the
   * alert row it settles on: the landing admitted `admitted` of the two
   * the page named. */
  const overLanding = (
    admitted: number,
    status: "already_checked_in" | "checked_in",
  ) => ({
    answer: {
      listingName: "Ceilidh",
      name: "Ada",
      overAdmission: { admitted, bought: HELD_PLACES, named: CHECK_IN_PICK },
      quantity: admitted,
      ...(status === "checked_in" ? { remaining: 0 } : {}),
      status,
      total: HELD_PLACES,
    },
    row: {
      className: "scanner-queue-alert",
      text: t("admin.scanner.queue_item_over_admitted", {
        admitted,
        bought: HELD_PLACES,
        name: "Ada",
        named: CHECK_IN_PICK,
      }),
    },
  });

  test("a scan made without a connection waits in the queue and checks in when the connection returns", async () => {
    const { page, server } = await openDoor();
    try {
      expect(await bannerHidden(page)).toBe(true);
      await setConnection(page, false);
      expect(await bannerHidden(page)).toBe(false);
      expect(await bannerText(page)).toBe(
        t("admin.scanner.offline_banner_auto"),
      );

      await scanWaitsInQueue(page);
      await syncChecksTheScanIn(page);
    } finally {
      await page.context().close();
      await server.shutdown();
      await server.finished;
    }
  });

  test("the switch queues scans, refuses a ticket the list does not hold, and survives a reload", async () => {
    const { page, server } = await openDoor();
    try {
      // The switch starts off, and arming it stores the position.
      expect(await togglePressed(page)).toBe("false");
      await page.click("#scanner-offline-toggle");
      expect(await togglePressed(page)).toBe("true");
      expect(await bannerText(page)).toBe(
        t("admin.scanner.offline_banner_manual"),
      );

      await setConnection(page, false);
      expect(await bannerText(page)).toBe(
        t("admin.scanner.offline_banner_auto"),
      );

      await scanWaitsInQueue(page);

      // The same ticket again: the queue already holds it.
      await statusShows(page, t("admin.scanner.offline_already_queued"));
      expect(deliveries).toEqual([]);

      // A ticket the door's list does not hold: refused, and nothing queued.
      await swapFrame(page, "unknown");
      await statusShows(page, t("admin.scanner.offline_invalid"));
      expect(await queueSummary(page)).toBe(
        t("admin.scanner.queue_count_one", { count: 1 }),
      );
      expect(deliveries).toEqual([]);

      await syncChecksTheScanIn(page);

      // The reload restores the switch the door armed, the mode's words, and
      // the emptied queue.
      await page.reload();
      expect(await togglePressed(page)).toBe("true");
      expect(await bannerText(page)).toBe(
        t("admin.scanner.offline_banner_manual"),
      );
      expect(await queuePanelHidden(page)).toBe(true);
      expect(await queueSummary(page)).toBe(
        t("admin.scanner.queue_count_other", { count: 0 }),
      );
    } finally {
      await page.context().close();
      await server.shutdown();
      await server.finished;
    }
  });

  test("a replayed check-in the booking could not fully supply alerts with the numbers", async () => {
    const { page, server } = await openDoor();
    try {
      // The replay reads the delivery's landing. The booking's places can
      // be gone when it lands: the numbers ride the answer the scan
      // endpoint sends.
      await setConnection(page, false);
      await scanWaitsInQueue(page);
      scanAnswer = overLanding(0, "already_checked_in").answer;
      await syncChecksTheScanIn(page, overLanding(0, "already_checked_in").row);

      // A second delivery, partly supplied: another door took one place
      // between the queueing and the sync.
      await setConnection(page, false);
      await scanWaitsInQueue(page);
      scanAnswer = overLanding(1, "checked_in").answer;
      await syncChecksTheScanIn(page, overLanding(1, "checked_in").row);
    } finally {
      await page.context().close();
      await server.shutdown();
      await server.finished;
    }
  });
});
