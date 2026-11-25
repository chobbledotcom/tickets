/// <reference lib="dom" />
// Browser-only code - bundled into /scanner.js by scripts/build-static-assets.ts
//
// The offline scanner's page furniture. The banner says which mode the door
// works in. A scan is validated offline and queued in the page's store. The
// module wires one page's offline side. The queue panel and the replay that
// settles it live in scanner-offline-sync.ts.

import { fromBase64Url } from "#crypto/utils.ts";
import { DAY_MS } from "#shared/now.ts";
import type { Wording } from "#shared/scanner-words.ts";
import { hmacHex } from "#shared/sha256.ts";
import type { TicketCacheEntry } from "#shared/ticket-cache.ts";
import type { ManualOffline, Person } from "./admin/manual-search.ts";
import { requiredById } from "./dom.ts";
import { showQuantitySelect } from "./quantity-select.ts";
import { failLoudly } from "./scan-flow.ts";
import type { Say } from "./scanner-messages.ts";
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

/** One door's offline side: the scan route it settles for, the page's
 * words, and its queue panel. */
export type OfflineDoor = {
  panel: QueuePanel;
  scanPath: string;
  wording: Wording;
};

/** Show or hide the offline banner, worded for why the mode is on. */
const updateOfflineBanner = (
  banner: HTMLElement,
  bannerText: HTMLElement,
  wording: Wording,
  scanPath: string,
): void => {
  const active = offlineModeActive(scanPath);
  banner.classList.toggle("hidden", !active);
  bannerText.textContent = wording.word(
    navigator.onLine ? "offlineBannerManual" : "offlineBannerAuto",
  );
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
 * throws. */
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
  { scanPath, wording }: OfflineDoor,
  say: Say,
  use: (entries: TicketCacheEntry[]) => Result,
): Result | null => {
  const cache = readTicketCacheOrNull(scanPath);
  if (cache === null || !isCacheFresh(cache)) {
    say(
      wording.word(cache ? "offlineCacheExpired" : "offlineCacheMissing"),
      "error",
    );
    return null;
  }
  return use(cache.entries);
};

/** Queue the check-in of one saved list entry. A camera scan reaches it by
 * the scanned ticket's digest, and a manual pick by the person's name. */
const queueSavedEntry = async (
  { panel, scanPath, wording }: OfflineDoor,
  entry: TicketCacheEntry,
  say: Say,
): Promise<void> => {
  // The door's own last-token guard expires after the status fades, so the
  // same ticket can reach this line twice. A second item sends the
  // check-in twice, and the door reads that as two admissions.
  if (
    readQueue().some(
      (item) => item.scanPath === scanPath && item.tokenHash === entry.hash,
    )
  ) {
    say(wording.word("offlineAlreadyQueued"), "error");
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
          wording.word("offlineQuantityAsk"),
          wording.ticketCount,
        )
      : 1;
  if (quantity === null) {
    say(wording.word("offlineNotQueued"), "warning");
    return;
  }
  const queued = queueCheckIn(scanPath, entry.hash, quantity);
  // A running sync owns the panel's rows: the new row joins the rows the
  // sync settles. A rebuild detaches the rows the sync writes to.
  if (isSyncing()) {
    appendQueuedRow(panel, wording, queued);
  } else {
    renderQueuePanel(panel, wording);
  }
  say(wording.word("offlineQueued"), "success");
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
  door: OfflineDoor,
  token: string,
  say: Say,
): Promise<void> => {
  await withUsableList(door, say, async (entries) => {
    const hash = await hmacHex(door.panel.doorKey, token);
    const entry = entries.find((saved) => saved.hash === hash);
    if (entry === undefined) {
      say(door.wording.word("offlineInvalid"), "error");
      return;
    }
    await queueSavedEntry(door, entry, say);
  });
};

/** The manual check-in's offline side for one door. A saved person's
 * check-in queues offline, and the door is done with the pick either
 * way. */
export const offlinePeople = (door: OfflineDoor): ManualOffline => ({
  active: () => offlineModeActive(door.scanPath),
  search: (text, say) => {
    const wanted = text.toLowerCase();
    return withUsableList(door, say, (entries) =>
      entries
        .filter((entry) => entry.name.toLowerCase().includes(wanted))
        .slice(0, SEARCH_MAX_RESULTS)
        .map(
          (entry): Person => ({
            checkIn: async (sayTo) => {
              await queueSavedEntry(door, entry, sayTo);
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
  say,
  scanPath,
  settleDelivery,
  wording,
}: {
  say: Say;
  scanPath: string;
  settleDelivery: SettleDelivery;
  wording: Wording;
}): QueuePanel => {
  const container = requiredById("scanner-container");
  const reportFailure = failLoudly(wording, say);
  /** The queue's sync, wired to this page's door. Its failure reaches the
   * door like any other. */
  const sync = () =>
    syncQueue(say, wording, panel, settleDelivery).catch(reportFailure);
  const panel: QueuePanel = {
    container: requiredById("scanner-queue"),
    doorKey: doorKeyBytes(container.dataset.doorCacheKey),
    list: requiredById("scanner-queue-items"),
    replayWindowMs: replayWindowMs(
      container.dataset.scanOperationRetentionDays,
    ),
    rows: [],
    summary: requiredById("scanner-queue-summary"),
    sync,
  };
  const banner = requiredById("scanner-offline-banner");
  const bannerText = requiredById("scanner-offline-banner-text");
  const toggle = requiredById("scanner-offline-toggle");

  /** The switch, the banner, and the queue all read one offline state. */
  const renderOfflineState = () => {
    toggle.setAttribute("aria-pressed", String(readManualMode(scanPath)));
    updateOfflineBanner(banner, bannerText, wording, scanPath);
    // While a sync runs it owns the queue's rows: a rebuild here detaches
    // the row elements the sync still writes its outcomes to.
    if (!isSyncing()) renderQueuePanel(panel, wording);
  };

  const offlineSwitch = wireOfflineSwitch({
    onChange: renderOfflineState,
    // Turning off settles what the door queued while the switch held the
    // scans, the same way a reload or a returning connection does.
    onTurnedOff: sync,
    progress: requiredById("scanner-offline-progress"),
    reportFailure,
    say,
    scanPath,
    toggle,
    wording,
  });

  // Connectivity coming back settles whatever the door queued, and both
  // connection flips re-word the banner.
  window.addEventListener("online", () => {
    renderOfflineState();
    sync();
  });
  window.addEventListener("offline", renderOfflineState);

  registerScannerWorker().catch(reportFailure);
  offlineSwitch.refresh();
  renderOfflineState();
  sync();

  return panel;
};
