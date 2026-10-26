/**
 * Browser contract for the scanner door's connected paths on the served
 * page: the immediate check-in a scan makes while the connection is up, and
 * the door switch's own manual mode, which queues scans while the network
 * holds. Both walk the app's own page, cache endpoint, and scan endpoint —
 * the offline journeys that drop the connection live in
 * `offline-door-browser.contract.ts`.
 *
 * Runs under `deno task test:screenshot-contract` (Chromium required), never
 * in the main suite. The task builds the bundle the served page loads, so no
 * bundler process runs inside a test.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { t } from "#i18n";
import { describeWithBrowser } from "#test-utils/browser-contract.ts";
import {
  askPickCount,
  bannerHidden,
  bannerText,
  queueSettled,
  queueSummary,
  statusShows,
  togglePressed,
  waitText,
} from "./offline-door-page.ts";
import {
  CHECK_IN_PICK,
  checkRowsShow,
  deliveryBody,
  HELD_PLACES,
  openDoor,
  seedDoor,
  servedCacheEntries,
  waitDoorCacheStored,
} from "./offline-door-support.ts";

/** The body one online scan sends: the token it decoded, and the pick the
 * door's answer to the ask rode on. */
const scanBody = v.object({
  quantity: v.optional(v.pipe(v.number(), v.integer())),
  token: v.pipe(v.string(), v.nonEmpty()),
});

describeWithBrowser(
  "the served scanner door with the connection up",
  { db: true },
  (contract) => {
    test("a scan while connected checks in at once, through the scan endpoint", async () => {
      const door = await seedDoor("Online door", "Ceilidh");
      const { page, close, deliveries } = await openDoor(contract, door, {
        Ada: door.attendee.ticket_token,
      });
      try {
        await waitDoorCacheStored(page, door);
        await page.click("#scanner-start");

        // The scan posts while connected, before any queueing: the
        // endpoint's ask is the page's overlay, and it bounds the pick at
        // what one check-in at this door admits.
        await waitText(
          page,
          "scanner-quantity-message",
          t("admin.scanner.select_quantity", { name: "Ada" }),
        );
        expect(await askPickCount(page)).toBe(HELD_PLACES);
        expect(deliveries).toHaveLength(1);
        expect(v.parse(scanBody, deliveries[0]).quantity).toBeUndefined();
        // The online path queues nothing.
        expect(
          await page.evaluate(() => localStorage.getItem("scanner-queue")),
        ).toBeNull();

        await page.selectOption(
          "#scanner-quantity-select",
          String(CHECK_IN_PICK),
        );
        await page.click("#scanner-quantity-confirm");
        await statusShows(
          page,
          t("admin.scanner.checked_in_partial", {
            listingName: "Ceilidh",
            name: "Ada",
            tickets: CHECK_IN_PICK,
            total: HELD_PLACES,
          }),
        );
        expect(deliveries).toHaveLength(2);
        expect(v.parse(scanBody, deliveries[1]).quantity).toBe(CHECK_IN_PICK);

        // The check-in landed on the door's own records, and the queue
        // never entered the picture.
        await checkRowsShow(door.attendee.id, CHECK_IN_PICK);
        expect(
          await page.evaluate(() => localStorage.getItem("scanner-queue")),
        ).toBeNull();
        expect(await bannerHidden(page)).toBe(true);
      } finally {
        await close();
      }
    });

    test("the armed switch queues a scan while the connection is up and syncs when disarmed", async () => {
      const door = await seedDoor("Armed door", "Ceilidh");
      const { page, close, deliveries } = await openDoor(contract, door, {
        Ada: door.attendee.ticket_token,
      });
      try {
        await waitDoorCacheStored(page, door);

        // Arming the switch holds the door's scans while the network is up.
        await page.click("#scanner-offline-toggle");
        expect(await togglePressed(page)).toBe("true");
        expect(await bannerHidden(page)).toBe(false);
        expect(await bannerText(page)).toBe(
          t("admin.scanner.offline_banner_manual"),
        );

        await page.click("#scanner-start");
        await waitText(
          page,
          "scanner-quantity-message",
          t("admin.scanner.offline_quantity_ask"),
        );
        await page.selectOption(
          "#scanner-quantity-select",
          String(CHECK_IN_PICK),
        );
        await page.click("#scanner-quantity-confirm");
        await statusShows(page, t("admin.scanner.offline_queued"));
        expect(await queueSummary(page)).toBe(
          t("admin.scanner.queue_count_one", { count: 1 }),
        );
        // The switch's own behaviour: the check-in waits even though the
        // network is up, because the door armed the queue.
        expect(deliveries).toEqual([]);

        // Disarming settles what the door queued, through the scan endpoint.
        await page.click("#scanner-offline-toggle");
        expect(await togglePressed(page)).toBe("false");
        await statusShows(page, t("admin.scanner.sync_done"));
        expect(deliveries).toHaveLength(1);
        const delivery = v.parse(deliveryBody, deliveries[0]);
        expect(delivery.quantity).toBe(CHECK_IN_PICK);
        const served = await servedCacheEntries(contract, door);
        expect(served.map((entry) => entry.hash)).toContain(
          delivery.token_hash,
        );
        await queueSettled(page);
        expect(await bannerHidden(page)).toBe(true);

        // The check-in landed on the door's own records.
        await checkRowsShow(door.attendee.id, CHECK_IN_PICK);
      } finally {
        await close();
      }
    });
  },
);
