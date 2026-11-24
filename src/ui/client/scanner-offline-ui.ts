/// <reference lib="dom" />
// Browser-only code - bundled into /scanner.js by scripts/build-static-assets.ts
//
// The offline scanner's page furniture. The banner says which mode the door
// works in. A scan is validated offline and queued in the page's store. The
// module wires one page's offline side. The queue panel and the replay that
// settles it live in scanner-offline-sync.ts.

import { fromBase64Url } from "#crypto/utils.ts";
import { DAY_MS } from "#shared/now.ts";
import { hmacHex } from "#shared/sha256.ts";
import type { TicketCacheEntry } from "#shared/ticket-cache.ts";
import type { ManualOffline, Person, Say } from "./admin/manual-search.ts";
import { showQuantitySelect } from "./quantity-select.ts";
import {
  formatTicketCount,
  getMessage,
  showStatus,
} from "./scanner-messages.js";
import {
  isCacheFresh,
  isSyncing,
  offlineModeActive,
  queueCheckIn,
  readManualMode,
  readQueue,
  readTicketCacheOrNull,
  registerScannerWorker,
} from "./scanner-offline.ts";
import { wireOfflineSwitch } from "./scanner-offline-switch.ts";
import {
  appendQueuedRow,
  type QueueRow,
  renderQueuePanel,
  type SettleDelivery,
  syncQueue,
} from "./scanner-offline-sync.ts";

/** The offline side's queue panel. It holds the page elements of the
 * queue, the door's digest key and replay window, and the rendered rows.
 * `sync` is the queue's sync for this page's door. */
export type QueuePanel = {
  container: HTMLElement;
  doorKey: Uint8Array;
  list: HTMLElement;
  replayWindowMs: number;
  rows: QueueRow[];
  summary: HTMLElement;
  sync: () => void;
};

/** Show or hide the offline banner, worded for why the mode is on. */
const updateOfflineBanner = (
  banner: HTMLElement,
  bannerText: HTMLElement,
  messages: DOMStringMap,
  scanPath: string,
): void => {
  const active = offlineModeActive(scanPath);
  banner.classList.toggle("hidden", !active);
  if (active) {
    bannerText.textContent = navigator.onLine
      ? getMessage(
          messages,
          "messageOfflineBannerManual",
          "Offline mode is on. Scans are queued and checked in when you are back online.",
        )
      : getMessage(
          messages,
          "messageOfflineBannerAuto",
          "No connection. Scans are queued and checked in when you are back online.",
        );
  }
};

/** The door's cache key the page carries, decoded to the raw bytes a keyed
 * digest signs under. The page is the only response that holds a door's
 * key. The stored digests carry the same key. A scan cannot use them
 * without this attribute. */
const doorKeyBytes = (pageKey: string | undefined): Uint8Array => {
  if (!pageKey) {
    throw new Error("The scanner page carries no data-door-cache-key");
  }
  return fromBase64Url(pageKey);
};

/** The door's replay window the page carries, in milliseconds. The server
 * keeps one queued delivery's replay record for this window. Past it the
 * server cannot tell a resend from a first send, so the page sends no
 * queued check-in this old. A page that carries no usable day count
 * throws, and the page degrades to the online-only scanner. */
const replayWindowMs = (pageDays: string | undefined): number => {
  const days = Number(pageDays);
  if (!Number.isSafeInteger(days) || days <= 0) {
    throw new Error(
      "The scanner page carries no usable data-scan-operation-retention-days",
    );
  }
  return days * DAY_MS;
};

/** The most saved people one name search shows. */
const SEARCH_MAX_RESULTS = 20;

/** Run `use` on the door's saved entries when the list can vouch for a
 * check-in. Null after the door hears why it cannot: no list on this
 * device, or an expired one. */
const withUsableList = <Result>(
  scanPath: string,
  say: Say,
  messages: DOMStringMap,
  use: (entries: TicketCacheEntry[]) => Result,
): Result | null => {
  const cache = readTicketCacheOrNull(scanPath);
  if (!cache) {
    say(
      getMessage(
        messages,
        "messageOfflineCacheMissing",
        "No offline ticket list on this device. Go online and turn on offline mode first.",
      ),
      "error",
    );
    return null;
  }
  if (!isCacheFresh(cache)) {
    say(
      getMessage(
        messages,
        "messageOfflineCacheExpired",
        "The offline ticket list has expired. Go online and reload this page.",
      ),
      "error",
    );
    return null;
  }
  return use(cache.entries);
};

/** Queue the check-in of one saved list entry. A camera scan reaches it by
 * the scanned ticket's digest, and a manual pick by the person's name. */
const queueSavedEntry = async (
  scanPath: string,
  entry: TicketCacheEntry,
  say: Say,
  messages: DOMStringMap,
  panel: QueuePanel,
): Promise<void> => {
  // The door's own last-token guard expires after the status fades, so the
  // same ticket can reach this line twice. A second item sends the
  // check-in twice, and the door reads that as two admissions.
  if (
    readQueue().some(
      (item) => item.scanPath === scanPath && item.tokenHash === entry.hash,
    )
  ) {
    say(
      getMessage(
        messages,
        "messageOfflineAlreadyQueued",
        "This ticket is already queued. Do not let them in again.",
      ),
      "error",
    );
    return;
  }
  // The door picks how many people this check-in admits, offline as
  // online. The stored list bounds the pick at what one scan at this door
  // admits. The server answers what it can still supply, and says so when
  // another door took some first. A booking whose one-scan count is one
  // place admits it without an ask.
  const quantity =
    entry.quantity > 1
      ? await showQuantitySelect(
          entry.quantity,
          getMessage(
            messages,
            "messageOfflineQuantityAsk",
            "How many people are you checking in?",
          ),
          (count: number) => formatTicketCount(messages, count),
        )
      : 1;
  if (!quantity) {
    say(
      getMessage(
        messages,
        "messageOfflineNotQueued",
        "Nothing was queued. Scan the ticket again to check them in.",
      ),
      "warning",
    );
    return;
  }
  // A storage failure here leaves the scan unqueued, and the save-failed
  // message tells the door to scan again.
  let queued: ReturnType<typeof queueCheckIn>;
  try {
    queued = queueCheckIn(scanPath, entry.hash, quantity);
  } catch {
    say(
      getMessage(
        messages,
        "messageOfflineSaveFailed",
        "This scan was not saved. Free up space on this device, then scan it again.",
      ),
      "error",
    );
    return;
  }
  // A running sync owns the panel's rows: the new row joins the rows the
  // sync settles. A rebuild detaches the rows the sync writes to.
  if (isSyncing()) {
    appendQueuedRow(panel, messages, queued);
  } else {
    renderQueuePanel(panel, messages);
  }
  say(
    getMessage(
      messages,
      "messageOfflineQueued",
      "Ticket looks valid. It will be checked in when you are back online.",
    ),
    "success",
  );
  // The connection can return while the scan's digest is still computing,
  // and the returning connection finds an empty store. The queued check-in
  // asks for the sync itself. A running sync takes the ask. An armed
  // switch holds the check-in. A dead connection leaves it queued.
  if (!readManualMode(scanPath)) panel.sync();
};

/** Validate one scan against the door's stored ticket hashes and queue the
 * check-in when the ticket looks legit. The scan makes no network call, so
 * the stored set is its only evidence. The click that turns offline mode on
 * downloads the set, and so does a page load while the switch is on. An
 * expired set answers nothing until the door reloads the page. */
export const offlineScan = async (
  scanPath: string,
  token: string,
  statusEl: HTMLElement,
  messages: DOMStringMap,
  panel: QueuePanel,
): Promise<void> => {
  const say: Say = (text, type) => showStatus(statusEl, text, type);
  await withUsableList(scanPath, say, messages, async (entries) => {
    const hash = await hmacHex(panel.doorKey, token);
    const entry = entries.find((saved) => saved.hash === hash);
    if (!entry) {
      say(
        getMessage(
          messages,
          "messageOfflineInvalid",
          "This ticket cannot be checked in offline. Scan it again when you are back online to see why.",
        ),
        "error",
      );
      return;
    }
    await queueSavedEntry(scanPath, entry, say, messages, panel);
  });
};

/** The manual check-in's offline side for one door. A saved person's
 * check-in queues offline, and the door is done with the pick either
 * way. */
export const offlinePeople = (
  scanPath: string,
  messages: DOMStringMap,
  panel: QueuePanel,
): ManualOffline => ({
  active: () => offlineModeActive(scanPath),
  search: (text, say) => {
    const wanted = text.toLowerCase();
    return withUsableList(scanPath, say, messages, (entries) =>
      entries
        .filter((entry) => entry.name.toLowerCase().includes(wanted))
        .slice(0, SEARCH_MAX_RESULTS)
        .map(
          (entry): Person => ({
            checkIn: async (sayTo) => {
              await queueSavedEntry(scanPath, entry, sayTo, messages, panel);
              return true;
            },
            details: entry.details,
            key: entry.hash,
            name: entry.name,
            quantity: entry.quantity,
          }),
        ),
    );
  },
});

/** Wire the offline side of one scanner page and return the panel the camera
 * loop hands each offline scan to. `settleDelivery` posts a queued
 * check-in's delivery and answers the door's final word for it. */
export const initOfflineScanner = ({
  messages,
  scanPath,
  settleDelivery,
  statusEl,
}: {
  messages: DOMStringMap;
  scanPath: string;
  settleDelivery: SettleDelivery;
  statusEl: HTMLElement;
}): QueuePanel => {
  /** The page's one element for `id`, or a hard stop when the page lacks it. */
  const lookup = (id: string): HTMLElement => {
    const found = document.getElementById(id);
    if (found) return found;
    throw new Error(`The scanner page carries no ${id}`);
  };
  const panel: QueuePanel = {
    container: lookup("scanner-queue"),
    doorKey: doorKeyBytes(lookup("scanner-container").dataset.doorCacheKey),
    list: lookup("scanner-queue-items"),
    replayWindowMs: replayWindowMs(
      lookup("scanner-container").dataset.scanOperationRetentionDays,
    ),
    rows: [],
    summary: lookup("scanner-queue-summary"),
    /** The queue's sync, wired to this page's door. A check-in the door
     * queued as the connection returned asks for it once it lands. */
    sync: () => syncQueue(statusEl, messages, panel, settleDelivery),
  };
  const banner = lookup("scanner-offline-banner");
  const bannerText = lookup("scanner-offline-banner-text");
  const toggle = lookup("scanner-offline-toggle");

  /** The switch, the banner, and the queue all read one offline state. */
  const renderOfflineState = () => {
    toggle.setAttribute("aria-pressed", String(readManualMode(scanPath)));
    updateOfflineBanner(banner, bannerText, messages, scanPath);
    // While a sync runs it owns the queue's rows: a rebuild here detaches
    // the row elements the sync still writes its outcomes to.
    if (!isSyncing()) renderQueuePanel(panel, messages);
  };

  const offlineSwitch = wireOfflineSwitch({
    messages,
    onChange: renderOfflineState,
    // Turning off settles what the door queued while the switch held the
    // scans, the same way a reload or a returning connection does.
    onTurnedOff: panel.sync,
    progress: lookup("scanner-offline-progress"),
    scanPath,
    statusEl,
    toggle,
  });

  // Connectivity coming back settles whatever the door queued, and both
  // connection flips re-word the banner.
  window.addEventListener("online", () => {
    renderOfflineState();
    syncQueue(statusEl, messages, panel, settleDelivery);
  });
  window.addEventListener("offline", () => renderOfflineState());

  registerScannerWorker();
  offlineSwitch.refresh();
  renderOfflineState();
  syncQueue(statusEl, messages, panel, settleDelivery);

  return panel;
};
