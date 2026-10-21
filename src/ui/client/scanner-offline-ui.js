// Browser-only code - bundled into /scanner.js by scripts/build-static-assets.ts
//
// The offline scanner's page furniture. The banner says which mode the door
// works in. The queue panel shows every queued check-in and its settled
// outcome. The module also validates a scan offline, and replays the queue
// once the connection is back.

import { fromBase64Url } from "#crypto/utils.ts";
import { hmacHex } from "#shared/sha256.ts";
import { getMessage, interpolate, showStatus } from "./scanner-messages.js";
import {
  dropFromQueue,
  isCacheFresh,
  isSyncing,
  offlineModeActive,
  queueCheckIn,
  readManualMode,
  readQueue,
  readTicketCache,
  refreshTicketCache,
  registerScannerWorker,
  setSyncing,
  writeManualMode,
} from "./scanner-offline.js";

/** The words a settled queue row carries. A declined ask and a refused
 * ticket read the same way to the door: nobody was checked in. */
const queueOutcome = (messages, answer) => {
  switch (answer?.status) {
    case "checked_in":
      return getMessage(messages, "messageQueueItemCheckedIn", "Checked in");
    case "already_checked_in":
      return getMessage(
        messages,
        "messageQueueItemAlready",
        "Was already checked in",
      );
    case "refunded":
      return getMessage(
        messages,
        "messageQueueItemRefunded",
        "Refunded — not checked in",
      );
    case "wrong_listing":
      return getMessage(
        messages,
        "messageNoDoor",
        "This ticket has no door to check in at",
      );
    case "not_found":
      return getMessage(messages, "messageNotFound", "Ticket not found");
    case "error":
      return answer.message;
    default:
      // verify_id and select_quantity reach the queue only as declined asks.
      return getMessage(
        messages,
        "messageQueueItemNotCheckedIn",
        "Not checked in",
      );
  }
};

/** The queued count above the panel's rows: what is still pending in the
 * store. Rows stay on the page with their outcome after the sync, so the
 * door sees every result — including which tickets were already checked in
 * elsewhere. */
const renderQueueCount = (panel, messages) => {
  const count = readQueue().length;
  panel.summary.textContent = interpolate(
    getMessage(
      messages,
      count === 1 ? "messageQueueCountOne" : "messageQueueCountOther",
      "{count} queued check-ins",
    ),
    { count },
  );
  panel.container.classList.toggle(
    "hidden",
    count === 0 && panel.rows.length === 0,
  );
};

/** Rebuild the queue panel's rows from the stored queue, oldest first. */
const renderQueuePanel = (panel, messages) => {
  panel.list.replaceChildren();
  panel.rows = [];
  for (const item of readQueue()) {
    const row = document.createElement("li");
    row.textContent = getMessage(
      messages,
      "messageQueueItemQueued",
      "Waiting — will be checked in when online",
    );
    panel.list.appendChild(row);
    panel.rows.push({ item, row });
  }
  renderQueueCount(panel, messages);
};

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

/** Validate one scan against the door's stored ticket hashes and queue the
 * check-in when the ticket looks legit. The stored set is the only evidence
 * offline, so it must be fresh. An expired set answers nothing, and a
 * refresh that cannot run keeps the stored set. */
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
  if (!cache || !isCacheFresh(cache)) {
    // Offline, the refresh fails and the stored set stands. The fallbacks
    // below say exactly what the door then sees.
    cache = await refreshTicketCache(scanPath).catch(() => cache);
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
  if (!cache.hashes.includes(hash)) {
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
      (item) => item.scanPath === scanPath && item.token === token,
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
  queueCheckIn(scanPath, token);
  renderQueuePanel(panel, messages);
  showStatus(
    statusEl,
    getMessage(
      messages,
      "messageOfflineQueued",
      "Ticket looks valid. It will be checked in when you are back online.",
    ),
    "success",
  );
};

/** Send every queued check-in and report each one's outcome on its own row.
 * An item leaves the queue only after the door answered it, so nothing is
 * lost when the connection drops mid-sync. The door answers a replayed
 * check-in with already_checked_in rather than checking anyone in twice. */
const syncQueue = async (csrfToken, statusEl, messages, panel, settleScan) => {
  if (isSyncing() || !navigator.onLine || readQueue().length === 0) return;
  setSyncing(true);
  try {
    showStatus(
      statusEl,
      getMessage(
        messages,
        "messageSyncRunning",
        "Checking in queued tickets...",
      ),
      "success",
    );
    for (const { item, row } of panel.rows) {
      try {
        const answer = await settleScan(
          item.scanPath,
          item.token,
          csrfToken,
          statusEl,
          messages,
        );
        dropFromQueue(item);
        row.textContent = queueOutcome(messages, answer);
      } catch {
        row.textContent = getMessage(
          messages,
          "messageQueueItemStillQueued",
          "Not sent yet — still queued",
        );
      }
      renderQueueCount(panel, messages);
    }
    showStatus(
      statusEl,
      getMessage(messages, "messageSyncDone", "Queued tickets are done."),
      "success",
    );
  } finally {
    setSyncing(false);
  }
};

/** Wire the offline side of one scanner page and return the panel the camera
 * loop hands each offline scan to. */
export const initOfflineScanner = ({
  csrfToken,
  messages,
  scanPath,
  settleScan,
  statusEl,
}) => {
  const lookup = (id) => {
    const found = document.getElementById(id);
    if (!found) throw new Error(`The scanner page carries no ${id}`);
    return found;
  };
  const panel = {
    container: lookup("scanner-queue"),
    doorKey: doorKeyBytes(lookup("scanner-container").dataset.doorCacheKey),
    list: lookup("scanner-queue-items"),
    rows: [],
    summary: lookup("scanner-queue-summary"),
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
    renderQueuePanel(panel, messages);
  };

  toggle.addEventListener("click", () => {
    writeManualMode(!readManualMode());
    renderOfflineState();
    // Arming the mode wants a fresh list while there is still a connection.
    // Offline, the refresh fails and any stored set stands.
    if (readManualMode() && navigator.onLine) refreshQuietly();
    // Disarming settles what the door queued while the switch held the
    // scans, the same way a reload or a returning connection does.
    if (!readManualMode()) {
      syncQueue(csrfToken, statusEl, messages, panel, settleScan);
    }
  });

  // Connectivity coming back settles whatever the door queued, and both
  // connection flips re-word the banner.
  window.addEventListener("online", () => {
    renderOfflineState();
    syncQueue(csrfToken, statusEl, messages, panel, settleScan);
  });
  window.addEventListener("offline", () => renderOfflineState());

  registerScannerWorker();
  refreshQuietly();
  renderOfflineState();
  syncQueue(csrfToken, statusEl, messages, panel, settleScan);

  return panel;
};
