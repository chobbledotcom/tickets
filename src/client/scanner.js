// Browser-only code - bundled with jsQR by scripts/build-edge.ts
import jsQR from "jsqr";

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

/** POST to scan API */
const postScan = async (eventId, token, csrfToken, force) => {
  const body = { token };
  if (force) body.force = true;

  const res = await fetch(`/admin/event/${eventId}/scan`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
    },
    body: JSON.stringify(body),
  });

  return res.json();
};

const formatTicketCount = (count) => {
  const safeCount = Number.isFinite(count) ? count : 1;
  return `${safeCount} ticket${safeCount === 1 ? "" : "s"}`;
};

/** Show a status message with color via CSS classes */
const showStatus = (el, message, type) => {
  el.textContent = message;
  el.classList.remove("hidden", "scanner-status-success", "scanner-status-warning", "scanner-status-error");
  el.classList.add("scanner-status", `scanner-status-${type}`);
};

/** Handle a scan result and display status */
const handleResult = (el, result) => {
  switch (result.status) {
    case "checked_in":
      showStatus(el, `${result.name} checked in (${formatTicketCount(result.quantity)})`, "success");
      break;
    case "already_checked_in":
      showStatus(
        el,
        `${result.name} already checked in (${formatTicketCount(result.quantity)})`,
        "warning",
      );
      break;
    case "refunded":
      showStatus(el, `${result.name} has been refunded`, "error");
      break;
    case "not_found":
      showStatus(el, "Ticket not found", "error");
      break;
    case "error":
      showStatus(el, result.message, "error");
      break;
  }
};

/** Main scanner loop */
const startScanner = (video, canvas, statusEl, eventId, csrfToken) => {
  const ctx = canvas.getContext("2d");
  let lastScanTime = 0;
  let processing = false;

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
      showStatus(statusEl, "Invalid QR code", "error");
      lastScanTime = Date.now();
      setTimeout(scan, SCAN_INTERVAL_MS);
      return;
    }

    processing = true;
    lastScanTime = Date.now();

    postScan(eventId, token, csrfToken)
      .then(async (result) => {
        if (result.status === "wrong_event") {
          const ok = confirm(
            `${result.name} is registered for "${result.eventName}", not this event. Check in anyway?`,
          );
          if (ok) {
            const forced = await postScan(eventId, token, csrfToken, true);
            handleResult(statusEl, forced);
          } else {
            showStatus(statusEl, `Skipped ${result.name}`, "warning");
          }
        } else {
          handleResult(statusEl, result);
        }
      })
      .catch(() => {
        showStatus(statusEl, "Network error", "error");
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

  if (!video || !statusEl || !startBtn) return;

  const eventId = video.dataset.eventId;
  const csrfMeta = document.querySelector('meta[name="csrf-token"]');
  const csrfToken = csrfMeta ? csrfMeta.content : "";

  /** Stop all camera tracks to release the hardware */
  const stopCamera = () => {
    const stream = video.srcObject;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
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
      showStatus(statusEl, "Scanning...", "success");
      startScanner(video, canvas, statusEl, eventId, csrfToken);
    } catch {
      showStatus(statusEl, "Camera access denied", "error");
    }
  });
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
