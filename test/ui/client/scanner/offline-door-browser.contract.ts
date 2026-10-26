/**
 * Browser contract for the offline door on the served scanner page.
 *
 * Everything the journeys touch is the app's own: the served page carries
 * the door's cache key, the cache endpoint serves the digest list the page
 * stores, and the scan endpoint answers each queued delivery for real, so
 * the journeys pin the page↔endpoint agreement instead of a stub of either.
 * The connection drop and return use the browser's own network emulation.
 * The shared harness in `offline-door-support.ts` opens the page, fakes the
 * camera, and reads the words the page shows.
 *
 * Runs under `deno task test:screenshot-contract` (Chromium required), never
 * in the main suite. The task builds the bundle the served page loads, so no
 * bundler process runs inside a test.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { Page } from "playwright";
import * as v from "valibot";
import { t } from "#i18n";
import { scanAtDoor } from "#test/features/admin/scanner/support.ts";
import { describeWithBrowser } from "#test-utils/browser-contract.ts";
import { bookTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import {
  askPickCount,
  bannerHidden,
  bannerText,
  firstQueueRow,
  queuePanelHidden,
  queueSettled,
  queueSummary,
  setConnection,
  statusShows,
  swapFrame,
  togglePressed,
  waitText,
} from "./offline-door-page.ts";
import {
  CHECK_IN_PICK,
  checkRowsShow,
  deliveryBody,
  HELD_PLACES,
  type OpenDoor,
  openDoor,
  type SeededDoor,
  seedDoor,
  storedCacheEntries,
  waitDoorCacheStored,
} from "./offline-door-support.ts";

describeWithBrowser(
  "the offline door on the served scanner page",
  { db: true },
  (contract) => {
    /** Answers the ask one offline scan opens and asserts what the door
     * sees: the ask names how many people the check-in admits and bounds
     * the pick at the served list, the door checks in two of the booking's
     * three, and the queued words, one waiting row, one pending check-in,
     * and no request sent. */
    const scanWaitsInQueue = async (
      page: Page,
      deliveries: Record<string, unknown>[],
    ): Promise<void> => {
      const sentBefore = deliveries.length;
      await waitText(
        page,
        "scanner-quantity-message",
        t("admin.scanner.offline_quantity_ask"),
      );
      expect(await askPickCount(page)).toBe(HELD_PLACES);
      // The whole party is the common case, so it starts selected. The door
      // checks in two of the three.
      await page.selectOption(
        "#scanner-quantity-select",
        String(CHECK_IN_PICK),
      );
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
     * sent with a digest the served list holds, its own operation id, and
     * the people the door picked; the row the answer settled on, and the
     * queue emptied. */
    const syncChecksTheScanIn = async (
      page: Page,
      door: SeededDoor,
      deliveries: OpenDoor["deliveries"],
      row: { className: string; text: string } = {
        className: "",
        text: t("admin.scanner.queue_item_checked_in"),
      },
    ): Promise<void> => {
      const sentBefore = deliveries.length;
      const stored = await storedCacheEntries(page, door);
      await setConnection(page, true);
      await statusShows(page, t("admin.scanner.sync_done"));
      // One delivery this sync: the queued check-in's own body, with a
      // digest the door's served list holds.
      expect(deliveries.length).toBe(sentBefore + 1);
      const delivery = v.parse(deliveryBody, deliveries.at(-1));
      expect(delivery.quantity).toBe(CHECK_IN_PICK);
      expect(stored.map((entry) => entry.hash)).toContain(delivery.token_hash);
      await queueSettled(page, row);
    };

    /** The alert row one over-admitted delivery lands with: the landing
     * admitted `admitted` of the two the door named for `who`. */
    const overAdmittedRow = (
      who: string,
      admitted: number,
    ): { className: string; text: string } => ({
      className: "scanner-queue-alert",
      text: t("admin.scanner.queue_item_over_admitted", {
        admitted,
        bought: HELD_PLACES,
        name: who,
        named: CHECK_IN_PICK,
      }),
    });

    test("a scan made without a connection waits in the queue and checks in when the connection returns", async () => {
      const door = await seedDoor("Offline door", "Ceilidh");
      const { page, close, deliveries } = await openDoor(contract, door, {
        Ada: door.attendee.ticket_token,
      });
      try {
        expect(await bannerHidden(page)).toBe(true);
        await waitDoorCacheStored(page, door);
        await setConnection(page, false);
        expect(await bannerHidden(page)).toBe(false);
        expect(await bannerText(page)).toBe(
          t("admin.scanner.offline_banner_auto"),
        );

        await page.click("#scanner-start");
        await scanWaitsInQueue(page, deliveries);
        await syncChecksTheScanIn(page, door, deliveries);
        await checkRowsShow(door.attendee.id, CHECK_IN_PICK);
      } finally {
        await close();
      }
    });

    test("the switch queues scans, refuses a ticket the list does not hold, and survives a reload", async () => {
      const door = await seedDoor("Manual door", "Ceilidh");
      const { page, close, deliveries } = await openDoor(contract, door, {
        Ada: door.attendee.ticket_token,
      });
      try {
        await waitDoorCacheStored(page, door);
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

        await page.click("#scanner-start");
        await scanWaitsInQueue(page, deliveries);

        // A ticket the door's list does not hold: refused, and nothing
        // queued. The different frame also breaks the camera's same-ticket
        // guard, so the held ticket rescans at once after it.
        await swapFrame(page, "unknown");
        await statusShows(page, t("admin.scanner.offline_invalid"));

        // The held ticket again: the queue already holds it.
        await swapFrame(page, "Ada");
        await statusShows(page, t("admin.scanner.offline_already_queued"));
        expect(await queueSummary(page)).toBe(
          t("admin.scanner.queue_count_one", { count: 1 }),
        );
        expect(deliveries).toEqual([]);

        await syncChecksTheScanIn(page, door, deliveries);

        // The reload restores the switch the door armed, the mode's words,
        // and the emptied queue.
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
        await close();
      }
    });

    test("a replayed check-in the booking could not fully supply alerts with the numbers", async () => {
      const door = await seedDoor("Replay door", "Ceilidh");
      const bea = await bookTestAttendee(
        [{ listingId: door.listing.id, quantity: HELD_PLACES }],
        "Bea",
        "bea@example.com",
      );
      const { page, close, deliveries } = await openDoor(contract, door, {
        Ada: door.attendee.ticket_token,
        Bea: bea.ticket_token,
      });
      try {
        await waitDoorCacheStored(page, door);

        // Ada's delivery lands on a booking another check-in emptied while
        // the connection was down: the door named two people, none got in.
        await setConnection(page, false);
        await page.click("#scanner-start");
        await scanWaitsInQueue(page, deliveries);
        const emptied = await scanAtDoor(door.group.id, {
          quantity: HELD_PLACES,
          token: door.attendee.ticket_token,
        });
        expect(emptied.json.status).toBe("checked_in");
        await syncChecksTheScanIn(
          page,
          door,
          deliveries,
          overAdmittedRow("Ada", 0),
        );
        await checkRowsShow(door.attendee.id, HELD_PLACES);

        // Bea's delivery lands with one place left: another check-in took
        // two of the three between the queueing and the sync.
        await setConnection(page, false);
        await swapFrame(page, "Bea");
        await scanWaitsInQueue(page, deliveries);
        const shortened = await scanAtDoor(door.group.id, {
          quantity: CHECK_IN_PICK,
          token: bea.ticket_token,
        });
        expect(shortened.json.status).toBe("checked_in");
        await syncChecksTheScanIn(
          page,
          door,
          deliveries,
          overAdmittedRow("Bea", 1),
        );
        await checkRowsShow(bea.id, HELD_PLACES);
      } finally {
        await close();
      }
    });
  },
);
