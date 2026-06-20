// Browser-only code - bundled with jsQR by scripts/build-edge.ts
import jsQR from "jsqr";

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

/** POST to scan API */
const postScan = async (
  listingId,
  token,
  csrfToken,
  { force, idVerified } = {},
) => {
  const body = { token };
  if (force) body.force = true;
  if (idVerified) body.id_verified = true;

  const res = await fetch(`/admin/listing/${listingId}/scan`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
    },
    method: "POST",
  });

  return res.json();
};

const interpolate = (template, values) =>
  template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ""));

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

/** Handle a scan result and display status */
const handleResult = (el, result, messages) => {
  switch (result.status) {
    case "checked_in":
      showStatus(
        el,
        interpolate(getMessage(messages, "messageCheckedIn", "{name} checked in ({tickets})"), {
          name: result.name,
          tickets: formatTicketCount(messages, result.quantity),
        }),
        "success",
      );
      break;
    case "already_checked_in":
      showStatus(
        el,
        interpolate(
          getMessage(messages, "messageAlreadyCheckedIn", "{name} already checked in ({tickets})"),
          {
            name: result.name,
            tickets: formatTicketCount(messages, result.quantity),
          },
        ),
        "warning",
      );
      break;
    case "refunded":
      showStatus(el, interpolate(getMessage(messages, "messageRefunded", "{name} has been refunded"), { name: result.name }), "error");
      break;
    case "not_found":
      showStatus(el, getMessage(messages, "messageNotFound", "Ticket not found"), "error");
      break;
    case "error":
      showStatus(el, result.message, "error");
      break;
  }
};

/** Main scanner loop */
const startScanner = (video, canvas, statusEl, listingId, csrfToken, messages) => {
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

    postScan(listingId, token, csrfToken)
      .then(async (result) => {
        if (result.status === "wrong_listing") {
          const ok = await showConfirm(
            interpolate(
              getMessage(
                messages,
                "messageWrongListingConfirm",
                '{name} is registered for "{listingName}", not this listing. Check in anyway?',
              ),
              { listingName: result.listingName, name: result.name },
            ),
          );
          if (ok) {
            const forced = await postScan(listingId, token, csrfToken, {
              force: true,
            });
            handleResult(statusEl, forced, messages);
          } else {
            showStatus(statusEl, interpolate(getMessage(messages, "messageSkipped", "Skipped {name}"), { name: result.name }), "warning");
          }
        } else if (result.status === "verify_id") {
          const ok = await showConfirm(interpolate(getMessage(messages, "messageVerifyIdConfirm", 'Does their ID match "{name}"?'), { name: result.name }));
          if (ok) {
            const verified = await postScan(listingId, token, csrfToken, {
              idVerified: true,
            });
            handleResult(statusEl, verified, messages);
          } else {
            showStatus(statusEl, interpolate(getMessage(messages, "messageIdMismatch", "ID does not match {name}"), { name: result.name }), "error");
          }
        } else {
          handleResult(statusEl, result, messages);
        }
      })
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

/**
 * Non-blocking confirm overlay centered on the camera feed.
 * Returns a Promise<boolean> without freezing the camera feed.
 */
const showConfirm = (message) => {
  const overlay = document.getElementById("scanner-confirm");
  const msgEl = document.getElementById("scanner-confirm-message");
  const yesBtn = document.getElementById("scanner-confirm-yes");
  const noBtn = document.getElementById("scanner-confirm-no");
  const closeBtn = document.getElementById("scanner-confirm-close");

  msgEl.textContent = message;

  return new Promise((resolve) => {
    const cleanup = (value) => {
      yesBtn.removeEventListener("click", onYes);
      noBtn.removeEventListener("click", onNo);
      closeBtn.removeEventListener("click", onClose);
      document.removeEventListener("keydown", onKeydown);
      overlay.classList.add("hidden");
      resolve(value);
    };
    const onYes = () => cleanup(true);
    const onNo = () => cleanup(false);
    const onClose = () => cleanup(false);
    const onKeydown = (e) => {
      if (e.key === "Escape") cleanup(false);
    };

    yesBtn.addEventListener("click", onYes);
    noBtn.addEventListener("click", onNo);
    closeBtn.addEventListener("click", onClose);
    document.addEventListener("keydown", onKeydown);
    overlay.classList.remove("hidden");
  });
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

  const listingId = video.dataset.listingId;
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
      startScanner(video, canvas, statusEl, listingId, csrfToken, messages);
    } catch {
      showStatus(statusEl, getMessage(messages, "messageCameraDenied", "Camera access denied"), "error");
    }
  });
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
