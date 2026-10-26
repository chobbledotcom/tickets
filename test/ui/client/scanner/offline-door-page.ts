/** The served door page's words and controls, as the journeys read them:
 * the status line, the offline banner, the queue panel, the door switch,
 * and the quantity ask. Each reader names the element it needs, so a page
 * that lost one fails at once, the way a broken page must. The connection
 * drop and return use the browser's own network emulation.
 *
 * Runs under `deno task test:screenshot-contract` (Chromium required), never
 * in the main suite.
 */

import { expect } from "@std/expect";
import type { Page } from "playwright";
import { t } from "#i18n";

/** Asserts the queue after one settled check-in: the row the answer put
 * there, the emptied count above it, and the emptied store. */
export const queueSettled = async (
  page: Page,
  row: { className: string; text: string } = {
    className: "",
    text: t("admin.scanner.queue_item_checked_in"),
  },
): Promise<void> => {
  expect(await firstQueueRow(page)).toEqual(row);
  expect(await queueSummary(page)).toBe(
    t("admin.scanner.queue_count_other", { count: 0 }),
  );
  expect(await page.evaluate(() => localStorage.getItem("scanner-queue"))).toBe(
    "[]",
  );
};

const textOf = (page: Page, id: string): Promise<string> =>
  page.evaluate((elementId) => {
    const found = document.getElementById(elementId);
    if (!found) throw new Error(`The served page carries no ${elementId}`);
    return found.textContent;
  }, id);

/** Waits for the element to carry the text while it is shown. A closed
 * overlay keeps its words, so a wait must not settle on the previous ask's
 * leftovers: the page hides furniture with its own hidden class, and a
 * shown element carries it nowhere in its ancestor chain. A page that lost
 * the element fails at once, the way a broken page must. */
export const waitText = async (
  page: Page,
  id: string,
  text: string,
): Promise<void> => {
  await page.waitForFunction(
    ({ elementId, text }: { elementId: string; text: string }) => {
      const found = document.getElementById(elementId);
      if (!found) throw new Error(`The served page carries no ${elementId}`);
      for (let node: Element | null = found; node; node = node.parentElement) {
        if (node.classList.contains("hidden")) return false;
      }
      return found.textContent === text;
    },
    { elementId: id, text },
    { timeout: 20_000 },
  );
};

export const statusShows = (page: Page, text: string): Promise<void> =>
  waitText(page, "scanner-status", text);

export const bannerText = (page: Page): Promise<string> =>
  textOf(page, "scanner-offline-banner-text");

export const bannerHidden = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const banner = document.getElementById("scanner-offline-banner");
    if (!banner) {
      throw new Error("The served page carries no scanner-offline-banner");
    }
    return banner.classList.contains("hidden");
  });

export const queuePanelHidden = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const panel = document.getElementById("scanner-queue");
    if (!panel) throw new Error("The served page carries no scanner-queue");
    return panel.classList.contains("hidden");
  });

export const queueSummary = (page: Page): Promise<string> =>
  textOf(page, "scanner-queue-summary");

export const firstQueueRow = (
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

export const togglePressed = (page: Page): Promise<string> =>
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

/** How many picks the quantity ask offers: what one check-in at this door
 * admits, as the door's list or the scan answer carries it. */
export const askPickCount = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const select = document.getElementById("scanner-quantity-select");
    if (!(select instanceof HTMLSelectElement)) {
      throw new Error("The served page carries no scanner-quantity-select");
    }
    return select.options.length;
  });

/** Drops and restores the connection. The network emulation makes every
 * real fetch fail. Chromium's emulation does not reach the renderer's
 * connection state, so the test hands the page the state the network now
 * holds, the way the browser hands it over: the onLine value and the
 * state's own event. */
export const setConnection = async (
  page: Page,
  online: boolean,
): Promise<void> => {
  await page.context().setOffline(!online);
  await page.evaluate((state) => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => state,
    });
    window.dispatchEvent(new Event(state ? "online" : "offline"));
  }, online);
};

/** Swaps the ticket the camera's frame shows. */
export const swapFrame = (page: Page, who: string): Promise<void> =>
  page.evaluate((name) => {
    if (!window.showTicket) {
      throw new Error("The fake camera carries no frame swapper");
    }
    return window.showTicket(name);
  }, who);
