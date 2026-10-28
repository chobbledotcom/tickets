// Browser-only code - bundled with jsQR by scripts/build-edge.ts
import jsQR from "jsqr";
import { isSyncing, offlineModeActive } from "./scanner-offline.js";
import { initOfflineScanner, offlineScan } from "./scanner-offline-ui.js";
import {
  FADE_DELAY_MS,
  formatTicketCount,
  getMessage,
  interpolate,
  showStatus,
} from "./scanner-messages.js";
import { showQuantitySelect } from "./quantity-select.ts";
import { showConfirm } from "./confirm-dialog.ts";

const COOLDOWN_MS = 2000;
const SCAN_INTERVAL_MS = 150;

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

/** POST one JSON body to a scan API. The page names the API by the door it
 * posts to (one listing or a whole group), and the answer comes back as
 * JSON. */
const postScanBody = async (scanPath, csrfToken, body) => {
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

/** POST one live scan — the page names the door it posts to, so the same
 * client serves both. */
const postScan = async (scanPath, token, csrfToken, { force, idVerified, quantity } = {}) => {
  const body = { token };
  if (force) body.force = true;
  if (idVerified) body.id_verified = true;
  if (quantity) body.quantity = quantity;

  return postScanBody(scanPath, csrfToken, body);
};

/** Build a "{name} … ({tickets})" status message for a check-in result. */
const nameAndTicketsMessage = (messages, key, fallback, result) =>
  interpolate(getMessage(messages, key, fallback), {
    listingName: result.listingName,
    name: result.name,
    tickets: formatTicketCount(messages, result.quantity),
  });

/** Say the door sent this person away without checking them in. */
const skipPerson = (el, messages, name) =>
  showStatus(
    el,
    interpolate(getMessage(messages, "messageSkipped", "Skipped {name}"), { name }),
    "warning",
  );

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
    // Only the forced rescan lands here. The first wrong_listing answer asks
    // before it re-posts, and a ticket whose only rows are "No check-in"
    // answers wrong_listing again.
    case "wrong_listing":
      showStatus(el, getMessage(messages, "messageNoDoor", "This ticket has no door to check in at."), "error");
      break;
    case "not_found":
      showStatus(el, getMessage(messages, "messageNotFound", "Ticket not found"), "error");
      break;
    case "error":
      showStatus(el, result.message, "error");
      break;
  }
};

/** Ask the door one yes-or-no question in the page's own words. */
const askConfirm = (messages, key, fallback, values) =>
  showConfirm(interpolate(getMessage(messages, key, fallback), values));

/** Ask the door staff to confirm the person's ID. A decline says the
 * mismatch on the status line and answers the ask's own answer, so the
 * caller can return it. A confirmation answers null, and the caller sends
 * the ID-checked request. */
const askIdCheck = async (statusEl, messages, answer) => {
  const ok = await askConfirm(
    messages,
    "messageVerifyIdConfirm",
    'Does their ID match "{name}"?',
    { name: answer.name },
  );
  if (ok) return null;
  showStatus(
    statusEl,
    interpolate(getMessage(messages, "messageIdMismatch", "ID does not match {name}"), { name: answer.name }),
    "error",
  );
  return answer;
};

/** Send the person away, and answer with the ask they declined. */
const declineAsk = (statusEl, messages, name, answer) => {
  skipPerson(statusEl, messages, name);
  return answer;
};

/** Scan one token and settle it with the door: each ask is one
 * confirmation, then one re-POST. A wrong listing widens the door, an ID
 * check confirms the person, and a quantity ask picks how many tickets this
 * scan admits. Every later POST carries every answer the door already gave,
 * so nothing re-asks and nothing is lost. Returns the answer the scan
 * settled on — the door's final word, or the ask the door staff declined —
 * so the offline queue's sync can report each replayed check-in. */
const admitScan = async (scanPath, token, csrfToken, statusEl, messages) => {
  let answer = await postScan(scanPath, token, csrfToken);
  const given = {};
  while (true) {
    if (answer.status === "wrong_listing" && !given.force) {
      const ok = await askConfirm(
        messages,
        "messageWrongListingConfirm",
        '{name} is registered for "{listingName}", not this listing. Check in anyway?',
        { listingName: answer.listingName, name: answer.name },
      );
      if (!ok) return declineAsk(statusEl, messages, answer.name, answer);
      given.force = true;
    } else if (answer.status === "verify_id" && !given.idVerified) {
      const declined = await askIdCheck(statusEl, messages, answer);
      if (declined) return declined;
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
      if (!count) return declineAsk(statusEl, messages, answer.name, answer);
      given.quantity = count;
    } else {
      handleResult(statusEl, answer, messages);
      return answer;
    }
    answer = await postScan(scanPath, token, csrfToken, given);
  }
};

/** Main scanner loop */
const startScanner = (video, canvas, statusEl, scanPath, csrfToken, messages, panel) => {
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

    if (processing || Date.now() - lastScanTime < COOLDOWN_MS) {
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

    // A running sync holds the scans, so one overlay asks one question at a
    // time. The ignored scan gets words, or the silence reads as an
    // admission. The door rescans when the queue is done.
    let settle;
    if (isSyncing()) {
      showStatus(
        statusEl,
        getMessage(
          messages,
          "messageSyncHolds",
          "Checking in queued tickets. Scan again when done.",
        ),
        "warning",
      );
      settle = Promise.resolve();
    } else if (panel && offlineModeActive()) {
      settle = offlineScan(scanPath, token, statusEl, messages, panel);
    } else {
      settle = admitScan(scanPath, token, csrfToken, statusEl, messages);
    }
    settle
      .catch(() => {
        showStatus(statusEl, getMessage(messages, "messageNetworkError", "Network error"), "error");
      })
      .finally(() => {
        processing = false;
        setTimeout(scan, SCAN_INTERVAL_MS);
      });
  };

  scan();
};

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

  /** Settle one queued check-in: its delivery names the ticket digest it
   * stored, the operation id this one check-in answers by, and the people
   * it admits. The server answers once per delivery — a resend repeats the
   * first send's recorded admission. An ID check the door makes now rides
   * the same delivery, so the answer stays one admission. */
  const settleDelivery = async (item) => {
    const body = {
      operation_id: item.operationId,
      quantity: item.quantity,
      token_hash: item.tokenHash,
    };
    const answer = await postScanBody(item.scanPath, csrfToken, body);
    if (answer.status !== "verify_id") return answer;
    const declined = await askIdCheck(statusEl, messages, answer);
    return declined ?? postScanBody(item.scanPath, csrfToken, {
      ...body,
      id_verified: true,
    });
  };

  // The offline side owns its own elements: the banner, the queue panel, and
  // the door switch. It throws naming any one the page fails to render, and
  // its door key needs an engine with Uint8Array.fromBase64. Either failure
  // must not take the online scanner down with it: the offline side is
  // optional furniture, so the page degrades to the online-only scanner.
  let panel = null;
  try {
    panel = initOfflineScanner({
      messages,
      scanPath,
      settleDelivery,
      statusEl,
    });
  } catch {
    // The documented degrade: this page scans online only, as before the
    // offline side existed.
  }

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

  startBtn.addEventListener("click", async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      video.srcObject = stream;
      await video.play();
      startBtn.classList.add("hidden");
      video.classList.remove("hidden");
      showStatus(statusEl, getMessage(messages, "messageScanning", "Scanning..."), "success");
      startScanner(video, canvas, statusEl, scanPath, csrfToken, messages, panel);
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
export { admitScan, extractToken, handleResult, postScan, showConfirm };
