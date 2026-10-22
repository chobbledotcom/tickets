// Browser-only code - bundled with jsQR by scripts/build-edge.ts
import jsQR from "jsqr";
import { showConfirm } from "./confirm-dialog.ts";
import {
  interpolate,
  setupOfflineScanner,
  strictScannerPost,
} from "./scanner-offline.ts";
import { showQuantitySelect } from "./quantity-select.ts";

/** @typedef {import("./scanner-offline.ts").OfflineScanner} OfflineScanner */

const COOLDOWN_MS = 2000;
const SCAN_INTERVAL_MS = 150;
const FADE_DELAY_MS = 5000;

/** Extract ticket token from a checkin URL or raw token string */
const extractToken = (data) => {
  try {
    const url = new URL(data);
    const match = url.pathname.match(/^\/checkin\/([^/]+)$/);
    return match ? match[1] : null;
  } catch {
    // Not a URL - could be a raw token
    return /^[A-Za-z0-9_-]{8,}$/.test(data) ? data : null;
  }
};

/** POST to scan API — the page names it door it posts to (one listing or a
 * whole group), so the same client serves both. A replay names the person
 * by the token digest the device stored, because the device never held
 * the token itself. The replay also carries the delivery id the device
 * made up for it. */
const postScan = async (scanPath, token, csrfToken, { force, idVerified, operationId, quantity } = {}, asHash = false) => {
  const body = asHash ? { token_hash: token } : { token };
  if (force) body.force = true;
  if (idVerified) body.id_verified = true;
  if (operationId) body.operation_id = operationId;
  if (quantity) body.quantity = quantity;

  const res = await fetch(scanPath, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
    },
    method: "POST",
  });

  return res.json();
};

/** The scan POST the page trusts: only real scan answers pass. A login
 * page or a bare error can never settle a scan or a queued check-in. */
const trustedPost = strictScannerPost(postScan);

const getMessage = (messages, key, fallback) => messages[key] ?? fallback;

const formatTicketCount = (messages, count) => {
  const safeCount = Number.isFinite(count) ? count : 1;
  const key = safeCount === 1 ? "messageTicketCountOne" : "messageTicketCountOther";
  return interpolate(getMessage(messages, key, "{count} ticket"), {
    count: safeCount,
  });
};

let fadeTimer = 0;

/** Show a status message with color via CSS classes */
const showStatus = (el, message, type) => {
  clearTimeout(fadeTimer);
  el.textContent = message;
  el.classList.remove(
    "hidden",
    "scanner-status-success",
    "scanner-status-warning",
    "scanner-status-error",
    "scanner-status-fade-out",
  );
  el.classList.add("scanner-status", `scanner-status-${type}`);

  if (type === "success" || type === "warning") {
    fadeTimer = setTimeout(() => {
      el.classList.add("scanner-status-fade-out");
    }, FADE_DELAY_MS);
  }
};

/** Build a "{name} … ({tickets})" status message for a check-in result. */
const nameAndTicketsMessage = (messages, key, fallback, result) =>
  interpolate(getMessage(messages, key, fallback), {
    listingName: result.listingName,
    name: result.name,
    tickets: formatTicketCount(messages, result.quantity),
  });

/** Say the door sent this person away without checking them in, and hand
 * back the answer their ask came from. */
const skipPerson = (el, messages, answer) => {
  showStatus(
    el,
    interpolate(getMessage(messages, "messageSkipped", "Skipped {name}"), { name: answer.name }),
    "warning",
  );
  return answer;
};

/** Handle a scan result and display status */
const handleResult = (el, result, messages) => {
  switch (result.status) {
    case "checked_in":
      showStatus(
        el,
        result.total > result.quantity
          ? interpolate(
              getMessage(
                messages,
                "messageCheckedInPartial",
                "{name} checked in for {listingName} ({tickets} of {total} tickets)",
              ),
              { listingName: result.listingName, name: result.name, tickets: result.quantity, total: result.total },
            )
          : nameAndTicketsMessage(messages, "messageCheckedIn", "{name} checked in for {listingName} ({tickets})", result),
        "success",
      );
      break;
    case "already_checked_in":
      showStatus(
        el,
        nameAndTicketsMessage(
          messages,
          "messageAlreadyCheckedIn",
          "{name} already checked in for {listingName} ({tickets})",
          result,
        ),
        "warning",
      );
      break;
    case "refunded":
      showStatus(el, interpolate(getMessage(messages, "messageRefunded", "{name} has been refunded"), { name: result.name }), "error");
      break;
    // Only the forced rescan lands here: the first wrong_listing answer asks
    // before it re-posts, and a ticket whose only rows are "No check-in"
    // answers wrong_listing again.
    case "wrong_listing":
      showStatus(el, getMessage(messages, "messageNoDoor", "This ticket has no door to check in at"), "error");
      break;
    case "not_found":
      showStatus(el, getMessage(messages, "messageNotFound", "Ticket not found"), "error");
      break;
    case "error":
      showStatus(el, result.message, "error");
      break;
  }
};

/** Scan one token and settle it with the door: each ask is one
 * confirmation, then one re-POST. A wrong listing widens the door, an ID
 * check confirms the person, and a quantity ask picks how many tickets this
 * scan admits. Every later POST carries every answer the door already gave,
 * so nothing re-asks and nothing is lost. A replay runs the same flow with
 * its own post, which names the person by the stored digest. The answer the
 * admission settled on comes back, ask skips included, so a replay can say
 * which check-ins the door had already taken. */
const admitScan = async (scanPath, token, csrfToken, statusEl, messages, post = postScan) => {
  let answer = await post(scanPath, token, csrfToken);
  const given = {};
  while (true) {
    if (answer.status === "wrong_listing" && !given.force) {
      const ok = await showConfirm(
        interpolate(
          getMessage(
            messages,
            "messageWrongListingConfirm",
            '{name} is registered for "{listingName}", not this listing. Check in anyway?',
          ),
          { listingName: answer.listingName, name: answer.name },
        ),
      );
      if (!ok) {
        return skipPerson(statusEl, messages, answer);
      }
      given.force = true;
    } else if (answer.status === "verify_id" && !given.idVerified) {
      const ok = await showConfirm(interpolate(getMessage(messages, "messageVerifyIdConfirm", 'Does their ID match "{name}"?'), { name: answer.name }));
      if (!ok) {
        showStatus(statusEl, interpolate(getMessage(messages, "messageIdMismatch", "ID does not match {name}"), { name: answer.name }), "error");
        return answer;
      }
      given.idVerified = true;
    } else if (answer.status === "select_quantity") {
      const count = await showQuantitySelect(
        answer.max,
        interpolate(
          getMessage(messages, "messageSelectQuantity", "How many tickets for {name}?"),
          { name: answer.name },
        ),
        (count) => formatTicketCount(messages, count),
      );
      if (!count) {
        return skipPerson(statusEl, messages, answer);
      }
      given.quantity = count;
    } else {
      handleResult(statusEl, answer, messages);
      return answer;
    }
    answer = await post(scanPath, token, csrfToken, given);
  }
};

/** One scan, wherever the door is working. Offline mode sends every scan to
 * the saved list and queues. Online, the scan settles with the server. A
 * send that cannot land settles against the saved list too. The device
 * queues the check-ins it accepted and sends them once the connection is
 * back. A door working online behaves as before.
 *
 * @param {OfflineScanner} offline
 */
const dispatchScan = async (offline, scanPath, token, csrfToken, statusEl, messages) => {
  if (offline.routeScan() === "offline") {
    await offline.scan(token);
    return;
  }
  try {
    await admitScan(scanPath, token, csrfToken, statusEl, messages, trustedPost);
    // The door answered for good, so the connection is there. The waiting
    // check-ins can send.
    await offline.replay();
  } catch {
    // The send did not reach the door's server, or the answer was no scan
    // answer. The saved list takes the scan and queues its check-in for
    // the next replay.
    await offline.scan(token);
  }
};

/** Main scanner loop
 *
 * @param {OfflineScanner} offline
 */
const startScanner = (video, canvas, statusEl, scanPath, csrfToken, messages, offline) => {
  const ctx = canvas.getContext("2d");
  let lastScanTime = 0;
  let processing = false;
  let lastToken = null;
  let lastTokenTimer = 0;

  const scan = () => {
    if (video.readyState < video.HAVE_ENOUGH_DATA) {
      setTimeout(scan, SCAN_INTERVAL_MS);
      return;
    }

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);

    if (processing || offline.replaying() || Date.now() - lastScanTime < COOLDOWN_MS) {
      setTimeout(scan, SCAN_INTERVAL_MS);
      return;
    }

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(imageData.data, imageData.width, imageData.height);

    if (!code) {
      setTimeout(scan, SCAN_INTERVAL_MS);
      return;
    }

    const token = extractToken(code.data);
    if (!token) {
      showStatus(statusEl, getMessage(messages, "messageInvalidQr", "Invalid QR code"), "error");
      lastScanTime = Date.now();
      setTimeout(scan, SCAN_INTERVAL_MS);
      return;
    }

    if (token === lastToken) {
      setTimeout(scan, SCAN_INTERVAL_MS);
      return;
    }

    processing = true;
    lastScanTime = Date.now();
    clearTimeout(lastTokenTimer);
    lastToken = token;
    lastTokenTimer = setTimeout(() => {
      lastToken = null;
    }, FADE_DELAY_MS);

    dispatchScan(offline, scanPath, token, csrfToken, statusEl, messages)
      .finally(() => {
        processing = false;
        setTimeout(scan, SCAN_INTERVAL_MS);
      });
  };

  scan();
};

// The page's live offline mode, wired by init. Null on a broken page.
let scannerOffline = null;

/** Initialize scanner when DOM is ready */
const init = () => {
  const video = document.getElementById("scanner-video");
  const canvas = document.createElement("canvas");
  const statusEl = document.getElementById("scanner-status");
  const startBtn = document.getElementById("scanner-start");
  const scannerContainer = document.getElementById("scanner-container");

  if (!video || !statusEl || !startBtn || !scannerContainer) return;

  const messages = scannerContainer.dataset;

  const scanPath = video.dataset.scanPath;
  const csrfMeta = document.querySelector('meta[name="csrf-token"]');
  const csrfToken = csrfMeta ? csrfMeta.content : "";

  /** Stop all camera tracks to release the hardware */
  const stopCamera = () => {
    const stream = video.srcObject;
    if (stream) {
      for (const t of stream.getTracks()) {
        t.stop();
      }
    }
  };

  // Release camera when navigating away (including bfcache)
  document.addEventListener("pagehide", stopCamera);

  /** One full live admission of one queued check-in, through the page's
   * own flow, its asks included. */
  const admitQueued = (tokenHash, post, syncMessages) =>
    admitScan(scanPath, tokenHash, csrfToken, statusEl, syncMessages, post);

  /** The POST a replay runs: it names the person by the token digest the
   * device stored, because the device never held the token itself. */
  const postScanHash = (scanPath, tokenHash, csrfToken, choices) =>
    postScan(scanPath, tokenHash, csrfToken, choices, true);

  scannerOffline = setupOfflineScanner({
    admitOne: admitQueued,
    container: scannerContainer,
    doorCacheKey: scannerContainer.dataset.doorCacheKey ?? "",
    post: postScanHash,
    showStatus,
    statusEl,
    tokensPath: scannerContainer.dataset.tokensPath ?? "",
  });

  startBtn.addEventListener("click", async () => {
    // The scanning message paints before the camera answers, so a queued
    // check-in that settles during the camera's start keeps its answer on
    // the status line.
    showStatus(statusEl, getMessage(messages, "messageScanning", "Scanning..."), "success");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      video.srcObject = stream;
      await video.play();
      startBtn.classList.add("hidden");
      video.classList.remove("hidden");
      startScanner(video, canvas, statusEl, scanPath, csrfToken, messages, scannerOffline);
    } catch {
      showStatus(statusEl, getMessage(messages, "messageCameraDenied", "Camera access denied"), "error");
    }
  });
};

// The page's only script tag is type="module", so the document has finished
// parsing by the time this runs and init can start at once.
init();

// The tail that makes this a module bundle (like the order widget's): the
// served script tag is type="module", and these exports are the pieces the
// direct test drives through the built bundle.
export {
  admitScan,
  dispatchScan,
  extractToken,
  handleResult,
  scannerOffline as offline,
  postScan,
  showConfirm,
};
