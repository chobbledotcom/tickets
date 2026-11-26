/// <reference lib="dom" />
// Browser-only code - bundled with jsQR by scripts/build-static-assets.ts
import jsQRModule from "jsqr";
import * as v from "valibot";
import {
  ScannerWordsSchema,
  type Wording,
  wordingOf,
} from "#shared/scanner-words.ts";
import { initManualCheckin } from "./admin/manual-checkin.ts";
import { showConfirm } from "./confirm-dialog.ts";
import { requiredAttribute, requiredById, requiredChild } from "./dom.ts";
import {
  failLoudly,
  type Given,
  postScanBody,
  type Settled,
  sayAnswer,
  settleLiveScan,
  settleScan,
} from "./scan-flow.ts";
import { FADE_DELAY_MS, type Say, showStatus } from "./scanner-messages.ts";
import {
  isSyncing,
  offlineModeActive,
  type QueuedCheckIn,
} from "./scanner-offline.ts";
import {
  initOfflineScanner,
  offlinePeople,
  offlineScan,
  type QueuePanel,
} from "./scanner-offline-ui.ts";

/** What the bundle reads from one decoded QR code. */
const DecodedSchema = v.nullable(v.object({ data: v.string() }));

/** The text of the QR code in one frame, or null when it holds none. The
 * package's types describe a default export, but its CommonJS build
 * exports the decoder itself, so the bundle checks what it got. */
const decodeQrOrNull = (image: ImageData): string | null => {
  const decoder: unknown = jsQRModule;
  if (typeof decoder !== "function") {
    throw new Error("The jsqr package exports no decoder function");
  }
  return (
    v.parse(DecodedSchema, decoder(image.data, image.width, image.height))
      ?.data ?? null
  );
};

const COOLDOWN_MS = 2000;
const SCAN_INTERVAL_MS = 150;

const CHECKIN_PATH = /^\/checkin\/([^/]+)$/;
const RAW_TOKEN = /^[A-Za-z0-9_-]{8,}$/;

/** The ticket token a QR code holds: the token in a check-in URL, or a raw
 * token. Null for any other code. */
const extractToken = (data: string): string | null => {
  if (!URL.canParse(data)) return RAW_TOKEN.test(data) ? data : null;
  return new URL(data).pathname.match(CHECKIN_PATH)?.[1] ?? null;
};

/** Post one live scan with every answer the door gave so far. */
const postScan = (
  scanPath: string,
  token: string,
  csrfToken: string,
  given: Given,
) => postScanBody(scanPath, csrfToken, { ...given, token });

/** Scan one token and settle it with the door. A wrong listing asks to
 * widen the door, an ID check confirms the person, and a quantity ask
 * picks how many places this scan admits. */
const admitScan = async (
  scanPath: string,
  token: string,
  csrfToken: string,
  say: Say,
  wording: Wording,
): Promise<Settled> =>
  settleLiveScan(
    (given) => postScan(scanPath, token, csrfToken, given),
    { say, wording },
    ["select_quantity", "verify_id", "wrong_listing"],
  );

/** What the camera loop needs from the page. */
type CameraPage = {
  csrfToken: string;
  reportFailure: (error: unknown) => void;
  panel: QueuePanel;
  say: Say;
  scanPath: string;
  wording: Wording;
};

/** Settle one decoded token: the offline queue takes it while offline mode
 * settles the door, and a running sync holds it. The held scan gets words,
 * or the silence reads as an admission. */
const settleToken = (page: CameraPage, token: string): Promise<unknown> => {
  if (isSyncing()) {
    page.say(page.wording.word("syncHolds"), "warning");
    return Promise.resolve();
  }
  return offlineModeActive(page.scanPath)
    ? offlineScan(
        { panel: page.panel, scanPath: page.scanPath, wording: page.wording },
        token,
        page.say,
      )
    : admitScan(page.scanPath, token, page.csrfToken, page.say, page.wording);
};

/** The camera loop: decode a frame, settle a new token, and wait. A token
 * scanned again within the fade window is the same scan. */
const startScanner = (video: HTMLVideoElement, page: CameraPage): void => {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (ctx === null) throw new Error("The canvas gives no 2d context");
  const state = {
    forgetTimer: 0,
    lastScanTime: 0,
    lastToken: "",
    processing: false,
  };
  const again = () => setTimeout(scan, SCAN_INTERVAL_MS);

  /** The token of the frame the camera shows, or null when it holds none. */
  const frameCodeOrNull = (): string | null => {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);
    return decodeQrOrNull(ctx.getImageData(0, 0, canvas.width, canvas.height));
  };

  const scan = (): void => {
    const cooling = Date.now() - state.lastScanTime < COOLDOWN_MS;
    const waiting = video.readyState < video.HAVE_ENOUGH_DATA;
    const code =
      waiting || state.processing || cooling ? null : frameCodeOrNull();
    if (code === null) return void again();
    const token = extractToken(code);
    if (token === null) {
      state.lastScanTime = Date.now();
      page.say(page.wording.word("invalidQr"), "error");
      return void again();
    }
    if (token === state.lastToken) return void again();
    state.lastScanTime = Date.now();
    state.processing = true;
    state.lastToken = token;
    // Each new token restarts the window in which a rescan is the same scan.
    clearTimeout(state.forgetTimer);
    state.forgetTimer = setTimeout(() => {
      state.lastToken = "";
    }, FADE_DELAY_MS);
    settleToken(page, token)
      .catch(page.reportFailure)
      .finally(() => {
        state.processing = false;
        again();
      });
  };

  scan();
};

/** Wire one scanner page. The page always renders every element below. */
const init = (): void => {
  const container = requiredById<HTMLElement>("scanner-container");
  const video = requiredById<HTMLVideoElement>("scanner-video");
  const statusEl = requiredById<HTMLElement>("scanner-status");
  const startBtn = requiredById<HTMLElement>("scanner-start");
  const csrfToken = requiredChild<HTMLMetaElement>(
    document,
    'meta[name="csrf-token"]',
  ).content;
  const scanPath = requiredAttribute(container, "data-scan-path");
  const wording = wordingOf(
    v.parse(ScannerWordsSchema, JSON.parse(String(container.dataset.words))),
  );
  const say: Say = (text, type) => showStatus(statusEl, text, type);
  const reportFailure = failLoudly(wording, say);
  // A fault thrown in any listener on this page reaches the door too.
  window.addEventListener("error", (event) => reportFailure(event.error));
  window.addEventListener("unhandledrejection", (event) =>
    reportFailure(event.reason),
  );

  /** Settle one queued check-in. Its delivery names the ticket digest it
   * stored, the id this one check-in answers by, and the people it admits.
   * The server answers once per delivery, so a resend repeats the first
   * send's admission. An ID check the door makes now rides the same
   * delivery. */
  const settleDelivery = async (item: QueuedCheckIn) => {
    const body = {
      operation_id: item.operationId,
      quantity: item.quantity,
      token_hash: item.tokenHash,
    };
    const settled = await settleScan(
      (given) => postScanBody(item.scanPath, csrfToken, { ...body, ...given }),
      ["verify_id"],
      { say, wording },
    );
    return settled.answer;
  };

  const panel = initOfflineScanner({
    say,
    scanPath,
    settleDelivery,
    wording,
  });
  initManualCheckin({
    csrfToken,
    offline: offlinePeople({ panel, scanPath, wording }),
    scanPath,
    searchPath: requiredAttribute(container, "data-scan-search-path"),
    wording,
  });

  // Release the camera when the door leaves the page, bfcache included.
  document.addEventListener("pagehide", () => {
    for (const track of (video.srcObject as MediaStream | null)?.getTracks() ??
      []) {
      track.stop();
    }
  });

  startBtn.addEventListener("click", async () => {
    try {
      video.srcObject = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
    } catch {
      // A refused or missing camera is the door's own setting to change.
      say(wording.word("cameraDenied"), "error");
      return;
    }
    await video.play();
    startBtn.classList.add("hidden");
    video.classList.remove("hidden");
    say(wording.word("scanning"), "success");
    startScanner(video, {
      csrfToken,
      panel,
      reportFailure,
      say,
      scanPath,
      wording,
    });
  });
};

// The page's only script tag is type="module", so the document is parsed
// when this runs, and init can start at once.
init();

// The tail that makes this a module bundle. The served script tag is
// type="module". The direct test drives these exports through the built
// bundle.
export { admitScan, extractToken, sayAnswer, showConfirm, showStatus };
