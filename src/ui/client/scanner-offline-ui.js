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
  queueHolds,
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

/** One waiting row for the panel's list, paired with its stored item. */
const queuedRow = (panel, messages, item) => {
  const row = document.createElement("li");
  row.textContent = getMessage(
    messages,
    "messageQueueItemQueued",
    "Waiting — will be checked in when online",
  );
  panel.list.appendChild(row);
  return { item, row };
};

/** Rebuild the queue panel's rows from the stored queue, oldest first. */
const renderQueuePanel = (panel, messages) => {
  panel.list.replaceChildren();
  panel.rows = [];
  for (const item of readQueue()) {
    panel.rows.push(queuedRow(panel, messages, item));
  }
  renderQueueCount(panel, messages);
};

/** Add one queued check-in's waiting row without touching the rows already
 * on the panel. A running sync writes its answers to those rows, and the
 * loop settles the appended row too. */
const appendQueuedRow = (panel, messages, item) => {
  panel.rows.push(queuedRow(panel, messages, item));
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
  // A storage failure here leaves the scan unqueued, and the save-failed
  // message tells the door to scan again.
  let queued;
  try {
    queued = queueCheckIn(scanPath, token);
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

/** A sync asked for while another runs re-runs once the running one ends.
 * The ask that arrives mid-run — a returning connection, a disarm — must
 * not die with the run it interrupted. */
let syncRequested = false;

/** Send every queued check-in and report each one's outcome on its own row.
 * An item leaves the queue only after the door answered it with a scan
 * decision. Nothing is lost when the connection drops mid-sync or the door
 * refuses the page's session. The door answers a replayed check-in
 * with already_checked_in rather than checking anyone in twice. */
const syncQueue = async (csrfToken, statusEl, messages, panel, settleScan) => {
  if (isSyncing()) {
    syncRequested = true;
    return;
  }
  if (!navigator.onLine || readQueue().length === 0) return;
  setSyncing(true);

  /** Settle one queued check-in: send it, mark its answer on the row, and
   * drop it from the store. False when the store refused the removal, which
   * stops the sync. */
  const settleRow = async ({ item, row }) => {
    let answer;
    try {
      answer = await settleScan(
        item.scanPath,
        item.token,
        csrfToken,
        statusEl,
        messages,
      );
      // An answer without a scan decision is no settlement: an expired
      // session or a refused role leaves the check-in queued.
      if (typeof answer?.status !== "string") {
        throw new Error("The door sent no scan decision.");
      }
    } catch {
      // No answer or no scan decision — a dead connection, an expired
      // session, a refused role. The item waits for the next sync.
      row.textContent = getMessage(
        messages,
        "messageQueueItemStillQueued",
        "Not sent yet — still queued",
      );
      renderQueueCount(panel, messages);
      return true;
    }
    try {
      dropFromQueue(item);
    } catch {
      // The door answered, so the check-in is safe, but the store refused
      // the removal. A replay reads as already checked in, so the item
      // stands and the door learns why the row still waits.
      showStatus(
        statusEl,
        getMessage(
          messages,
          "messageQueueSaveFailed",
          "This device could not save the queued check-ins. Free up space, then reload this page.",
        ),
        "error",
      );
      return false;
    }
    row.textContent = queueOutcome(messages, answer);
    renderQueueCount(panel, messages);
    return true;
  };

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
    // A scan queued after this sync started appended its own row, so the
    // loop settles that item too. A row whose item an earlier run settled
    // left the store: the re-run a mid-sync ask scheduled must not replay
    // its check-in.
    for (const pair of panel.rows) {
      if (!queueHolds(pair.item)) continue;
      if (!(await settleRow(pair))) return;
    }
    const settledAll = readQueue().length === 0;
    showStatus(
      statusEl,
      getMessage(
        messages,
        settledAll ? "messageSyncDone" : "messageSyncStillQueued",
        settledAll
          ? "Queued tickets are done."
          : "Some tickets are still queued. The page will try to check them in again.",
      ),
      settledAll ? "success" : "warning",
    );
  } finally {
    setSyncing(false);
    if (syncRequested) {
      syncRequested = false;
      syncQueue(csrfToken, statusEl, messages, panel, settleScan);
    }
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
    /** The queue's sync, wired to this page's door. A check-in the door
     * queued as the connection returned asks for it once it lands. */
    sync: () => syncQueue(csrfToken, statusEl, messages, panel, settleScan),
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
