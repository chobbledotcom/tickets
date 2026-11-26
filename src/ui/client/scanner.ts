/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// Browser-only code - bundled with jsQR by scripts/build-edge.ts
import jsQR, { type QRCode } from "jsqr";
import { showConfirm } from "./confirm-dialog.ts";
import {
  admitScan,
  askIdCheck,
  handleResult,
  postScan,
  postScanBody,
} from "./scanner-admit.ts";
import type { ScanAnswer } from "./scanner-answer.ts";
import {
  FADE_DELAY_MS,
  getMessage,
  type Messages,
  showStatus,
} from "./scanner-messages.ts";
import {
  isSyncing,
  offlineModeActive,
  type QueuedCheckIn,
} from "./scanner-offline.ts";
import type { QueuePanel } from "./scanner-offline-sync.ts";
import { initOfflineScanner, offlineScan } from "./scanner-offline-ui.ts";

const COOLDOWN_MS = 2000;
const SCAN_INTERVAL_MS = 150;

/** Extract ticket token from a checkin URL or raw token string */
const extractToken = (data: string): string | null => {
  try {
    const url = new URL(data);
    const match = url.pathname.match(/^\/checkin\/([^/]+)$/);
    return match?.[1] ?? null;
  } catch {
    // Not a URL - could be a raw token
    return /^[A-Za-z0-9_-]{8,}$/.test(data) ? data : null;
  }
};

/** Main scanner loop */
const startScanner = (
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  statusEl: HTMLElement,
  scanPath: string,
  csrfToken: string,
  messages: Messages,
  panel: QueuePanel | null,
): void => {
  // A canvas the page just made always hands out its first 2d context.
  const ctx = canvas.getContext("2d")!;
  let lastScanTime = 0;
  let processing = false;
  let lastToken: string | null = null;
  let lastTokenTimer = 0;

  /** Settle one scanned token. A running sync holds the scans, so one
   * overlay asks one question at a time. The ignored scan gets words, or the
   * silence reads as an admission. The door rescans when the queue is done. */
  const settleScan = (token: string): Promise<unknown> => {
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
      return Promise.resolve();
    }
    if (panel && offlineModeActive()) {
      return offlineScan(scanPath, token, statusEl, messages, panel);
    }
    return admitScan(scanPath, token, csrfToken, statusEl, messages);
  };

  const scan = (): void => {
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
    // @ts-expect-error The jsQR typings call this import a module, but the bundler unwraps it to the function.
    const code: QRCode | null = jsQR(
      imageData.data,
      imageData.width,
      imageData.height,
    );

    if (!code) {
      setTimeout(scan, SCAN_INTERVAL_MS);
      return;
    }

    const token = extractToken(code.data);
    if (!token) {
      showStatus(
        statusEl,
        getMessage(messages, "messageInvalidQr", "Invalid QR code"),
        "error",
      );
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

    settleScan(token)
      .catch(() => {
        showStatus(
          statusEl,
          getMessage(messages, "messageNetworkError", "Network error"),
          "error",
        );
      })
      .finally(() => {
        processing = false;
        setTimeout(scan, SCAN_INTERVAL_MS);
      });
  };

  scan();
};

/** Initialize scanner when DOM is ready */
const init = (): void => {
  const video = document.querySelector<HTMLVideoElement>("#scanner-video");
  const canvas = document.createElement("canvas");
  const statusEl = document.getElementById("scanner-status");
  const startBtn = document.getElementById("scanner-start");
  const scannerContainer = document.getElementById("scanner-container");
  const scanPath = video?.dataset.scanPath;

  if (!video || !statusEl || !startBtn || !scannerContainer || !scanPath) {
    return;
  }

  const messages = scannerContainer.dataset;

  const csrfMeta = document.querySelector<HTMLMetaElement>(
    'meta[name="csrf-token"]',
  );
  const csrfToken = csrfMeta?.content ?? "";

  /** Settle one queued check-in: its delivery names the ticket digest it
   * stored, the operation id this one check-in answers by, and the people
   * it admits. The server answers once per delivery — a resend repeats the
   * first send's recorded admission. An ID check the door makes now rides
   * the same delivery, so the answer stays one admission. */
  const settleDelivery = async (item: QueuedCheckIn): Promise<ScanAnswer> => {
    const body = {
      operation_id: item.operationId,
      quantity: item.quantity,
      token_hash: item.tokenHash,
    };
    const answer = await postScanBody(item.scanPath, csrfToken, body);
    if (answer.status !== "verify_id") return answer;
    const declined = await askIdCheck(statusEl, messages, answer);
    return (
      declined ??
      postScanBody(item.scanPath, csrfToken, {
        ...body,
        id_verified: true,
      })
    );
  };

  // The offline side owns its own elements: the banner, the queue panel, and
  // the door switch. It throws naming any one the page fails to render, and
  // its door key needs an engine with Uint8Array.fromBase64. Either failure
  // must not take the online scanner down with it: the offline side is
  // optional furniture, so the page degrades to the online-only scanner.
  let panel: QueuePanel | null = null;
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

  /** The camera stream this page opened, held so the hardware can be
   * released. */
  let stream: MediaStream | null = null;

  /** Stop all camera tracks to release the hardware */
  const stopCamera = (): void => {
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
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      video.srcObject = stream;
      await video.play();
      startBtn.classList.add("hidden");
      video.classList.remove("hidden");
      showStatus(
        statusEl,
        getMessage(messages, "messageScanning", "Scanning..."),
        "success",
      );
      startScanner(
        video,
        canvas,
        statusEl,
        scanPath,
        csrfToken,
        messages,
        panel,
      );
    } catch {
      showStatus(
        statusEl,
        getMessage(messages, "messageCameraDenied", "Camera access denied"),
        "error",
      );
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
