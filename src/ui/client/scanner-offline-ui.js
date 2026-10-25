// Browser-only code - bundled into /scanner.js by scripts/build-static-assets.ts
//
// The offline scanner's page furniture. The banner says which mode the door
// works in. A scan is validated offline and queued in the page's store. The
// module wires one page's offline side. The queue panel and the replay that
// settles it live in scanner-offline-sync.js.

import { fromBase64Url } from "#crypto/utils.ts";
import { DAY_MS } from "#shared/now.ts";
import { hmacHex } from "#shared/sha256.ts";
import { showQuantitySelect } from "./quantity-select.ts";
import {
  formatTicketCount,
  getMessage,
  showStatus,
} from "./scanner-messages.js";
import {
  appendQueuedRow,
  renderQueuePanel,
  syncQueue,
} from "./scanner-offline-sync.js";
import {
  isCacheFresh,
  isSyncing,
  offlineModeActive,
  queueCheckIn,
  readManualMode,
  readQueue,
  readTicketCache,
  refreshTicketCache,
  registerScannerWorker,
  writeManualMode,
} from "./scanner-offline.js";

/** Show or hide the offline banner, worded for why the mode is on. */
const updateOfflineBanner = (banner, bannerText, messages) => {
  const active = offlineModeActive();
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
const doorKeyBytes = (pageKey) => {
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
const replayWindowMs = (pageDays) => {
  const days = Number(pageDays);
  if (!Number.isSafeInteger(days) || days <= 0) {
    throw new Error(
      "The scanner page carries no usable data-scan-operation-retention-days",
    );
  }
  return days * DAY_MS;
};

/** Validate one scan against the door's stored ticket hashes and queue the
 * check-in when the ticket looks legit. The scan makes no network call, so
 * the stored set is its only evidence. The page load refreshes the set
 * while the connection holds, and so does the click that arms the switch.
 * An expired set answers nothing until the door reloads the page. */
export const offlineScan = async (
  scanPath,
  token,
  statusEl,
  messages,
  panel,
) => {
  let cache;
  try {
    cache = readTicketCache(scanPath);
  } catch {
    // A dropped corrupt set reads as no set: the door sees the missing-list
    // message, and the next online load rebuilds the cache from scratch.
    cache = null;
  }
  if (!cache) {
    showStatus(
      statusEl,
      getMessage(
        messages,
        "messageOfflineCacheMissing",
        "No offline ticket list yet. Go online and reload this page first.",
      ),
      "error",
    );
    return;
  }
  if (!isCacheFresh(cache)) {
    showStatus(
      statusEl,
      getMessage(
        messages,
        "messageOfflineCacheExpired",
        "The offline ticket list has expired. Go online and reload this page.",
      ),
      "error",
    );
    return;
  }
  const hash = await hmacHex(panel.doorKey, token);
  const entry = cache.entries.find((saved) => saved.hash === hash);
  if (!entry) {
    showStatus(
      statusEl,
      getMessage(
        messages,
        "messageOfflineInvalid",
        "This ticket cannot be checked in offline. Scan it again when you are back online to see why.",
      ),
      "error",
    );
    return;
  }
  // The door's own last-token guard expires after the status fades, so the
  // same ticket can reach this line twice. A second item sends the
  // check-in twice, and the door reads that as two admissions.
  if (
    readQueue().some(
      (item) => item.scanPath === scanPath && item.tokenHash === hash,
    )
  ) {
    showStatus(
      statusEl,
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
    entry.tickets > 1
      ? await showQuantitySelect(
          entry.tickets,
          getMessage(
            messages,
            "messageOfflineQuantityAsk",
            "How many people are you checking in?",
          ),
          (count) => formatTicketCount(messages, count),
        )
      : 1;
  if (!quantity) {
    showStatus(
      statusEl,
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
  let queued;
  try {
    queued = queueCheckIn(scanPath, hash, quantity);
  } catch {
    showStatus(
      statusEl,
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
  showStatus(
    statusEl,
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
  if (!readManualMode()) panel.sync();
};

/** Wire the offline side of one scanner page and return the panel the camera
 * loop hands each offline scan to. The page hands in `settleDelivery`, the
 * one call that posts a queued check-in's delivery and answers the door's
 * final word for it. */
export const initOfflineScanner = ({
  messages,
  scanPath,
  settleDelivery,
  statusEl,
}) => {
  /** The page's one element for `id`, or a hard stop when the page lacks it. */
  const lookup = (id) => {
    const found = document.getElementById(id);
    if (found) return found;
    throw new Error(`The scanner page carries no ${id}`);
  };
  const panel = {
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

  /** The page loads with the door's ticket hashes on file, so a scan can be
   * validated before any connection is needed. */
  const refreshQuietly = () =>
    refreshTicketCache(scanPath).catch(() => {
      // A failed refresh keeps whatever stored set the door already holds.
    });

  /** The switch, the banner, and the queue all read one offline state. */
  const renderOfflineState = () => {
    toggle.setAttribute("aria-pressed", String(readManualMode()));
    updateOfflineBanner(banner, bannerText, messages);
    // While a sync runs it owns the queue's rows: a rebuild here detaches
    // the row elements the sync still writes its outcomes to.
    if (!isSyncing()) renderQueuePanel(panel, messages);
  };

  toggle.addEventListener("click", () => {
    if (!writeManualMode(!readManualMode())) {
      showStatus(
        statusEl,
        getMessage(
          messages,
          "messageOfflineModeSaveFailed",
          "Your change was not saved. Free up space on this device, then try again.",
        ),
        "error",
      );
      return;
    }
    renderOfflineState();
    // Arming the mode wants a fresh list while there is still a connection.
    // Offline, the refresh fails and any stored set stands.
    if (readManualMode() && navigator.onLine) refreshQuietly();
    // Disarming settles what the door queued while the switch held the
    // scans, the same way a reload or a returning connection does.
    if (!readManualMode()) {
      syncQueue(statusEl, messages, panel, settleDelivery);
    }
  });

  // Connectivity coming back settles whatever the door queued, and both
  // connection flips re-word the banner.
  window.addEventListener("online", () => {
    renderOfflineState();
    syncQueue(statusEl, messages, panel, settleDelivery);
  });
  window.addEventListener("offline", () => renderOfflineState());

  registerScannerWorker();
  refreshQuietly();
  renderOfflineState();
  syncQueue(statusEl, messages, panel, settleDelivery);

  return panel;
};
