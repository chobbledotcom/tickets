/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

/**
 * The scanner page's offline mode, wired onto one door: the saved list, the
 * queue counter, the banner, the manual switch, and the replay triggers.
 * The store rules behind it live in scanner-door-store.ts.
 */

import { sha256Hex } from "#crypto/sha256.ts";
import {
  type AdmitOne,
  type DoorScope,
  interpolate,
  type KeyValueStore,
  offlineModeOn,
  queueCheckIn,
  queuedCheckInHashes,
  replayGate,
  type ScanMessages,
  type ScanPost,
  savedHashList,
  saveHashList,
  scopeFromTokensPath,
  setOfflineMode,
  strictScannerPost,
} from "./scanner-door-store.ts";

const storeWithFallback = (): KeyValueStore => {
  const memory = new Map<string, string>();
  try {
    localStorage.setItem("scanner:probe", "1");
    localStorage.removeItem("scanner:probe");
    return localStorage;
  } catch {
    // Storage can be full or blocked. The door then works from memory for
    // this page visit, and the queue lives as long as the page does.
    return {
      getItem: (key) => memory.get(key) ?? null,
      removeItem: (key) => void memory.delete(key),
      setItem: (key, value) => void memory.set(key, value),
    };
  }
};

/** Register the offline shell's service worker. Plainly unsupported or
 * blocked registration leaves the page as it is today: online-only. */
const registerScannerServiceWorker = async (
  scriptUrl: string,
): Promise<void> => {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register(scriptUrl, {
      scope: "/admin/",
      type: "module",
    });
  } catch {
    // No offline shell this visit. The page still scans online as before.
  }
};

/** One status line write, worded the way the page's own status writer does
 * it (text plus the scanner-status-{kind} class). */
export type StatusWriter = (
  el: HTMLElement,
  text: string,
  kind: string,
) => void;

/** The page's offline elements, resolved once at setup. The banner and
 * the queue line sit inside the camera container. The toggle sits beside
 * the start button, outside it. All three ids are page-unique. An older
 * build's cached page can lack any of them. */
type OfflineUi = {
  banner: HTMLElement | null;
  queueLine: HTMLElement | null;
  toggle: HTMLElement | null;
};

/** Everything one page's offline mode reads and drives, resolved once. */
type OfflineContext = {
  message: (name: string) => string;
  messages: ScanMessages;
  scope: DoorScope;
  showStatus: StatusWriter;
  statusEl: HTMLElement;
  store: KeyValueStore;
  ui: OfflineUi;
};

/** Paint the whole offline UI from the door's stored state. The banner
 * shows while the door works offline. The switch carries its state. The
 * waiting line speaks in the door's own words. */
const renderOffline = (ctx: OfflineContext): void => {
  const modeOn = offlineModeOn(ctx.store, ctx.scope);
  const waiting = queuedCheckInHashes(ctx.store, ctx.scope).length;
  if (ctx.ui.banner) {
    ctx.ui.banner.classList.toggle("hidden", !modeOn);
  }
  if (ctx.ui.toggle) {
    ctx.ui.toggle.setAttribute("aria-pressed", String(modeOn));
    ctx.ui.toggle.textContent = ctx.message(
      modeOn ? "OfflineToggleOn" : "OfflineToggleOff",
    );
  }
  if (ctx.ui.queueLine) {
    ctx.ui.queueLine.classList.toggle("hidden", waiting === 0);
    ctx.ui.queueLine.textContent =
      waiting === 0
        ? ""
        : interpolate(
            ctx.message(
              waiting === 1 ? "OfflineQueueOne" : "OfflineQueueOther",
            ),
            { count: waiting },
          );
  }
};

/** Settle one offline scan against the saved list. A saved ticket queues
 * its check-in and says so. Anything else is refused with the way out. */
const settleOfflineScan = async (
  ctx: OfflineContext,
  token: string,
): Promise<void> => {
  const saved = savedHashList(ctx.store, ctx.scope, Date.now());
  if (saved === null) {
    ctx.showStatus(ctx.statusEl, ctx.message("OfflineScanNoList"), "error");
    return;
  }
  const tokenHash = await sha256Hex(token);
  if (saved.has(tokenHash)) {
    queueCheckIn(ctx.store, ctx.scope, tokenHash);
    ctx.showStatus(ctx.statusEl, ctx.message("OfflineScanSaved"), "warning");
  } else {
    ctx.showStatus(ctx.statusEl, ctx.message("OfflineScanUnknown"), "error");
  }
};

/** Everything the scanner page hands the offline mode. */
export type OfflineScannerSetup = {
  container: HTMLElement;
  statusEl: HTMLElement;
  showStatus: StatusWriter;
  tokensPath: string;
  serviceWorkerPath: string;
  /** One full live admission for one queued check-in: its digest, the
   * replay's post, and the replay's messages. The page owns the flow. The
   * offline mode owns what the post sends and what the messages say. */
  admitOne: AdmitOne;
  /** The page's post for a replay: it names the person by token digest,
   * because the device never held the token. */
  post: ScanPost;
};

/** What the scanner's scan loop reads to decide where a scan goes. */
export type OfflineScanner = {
  /** Where the next scan goes: straight to the saved list ("offline"), or
   * through the server ("online"). The manual switch decides. */
  routeScan: () => "offline" | "online";
  /** A replay is sending queued check-ins, so the camera stands down. */
  replaying: () => boolean;
  /** Check one scanned token against the saved list and either queue its
   * check-in or say why the door cannot take it. */
  scan: (token: string) => Promise<void>;
};

/** Wire the offline mode onto one scanner page. */
export const setupOfflineScanner = (
  setup: OfflineScannerSetup,
): OfflineScanner => {
  const ctx: OfflineContext = {
    message: (name) => setup.container.dataset[`message${name}`] ?? "",
    messages: { ...setup.container.dataset },
    scope: scopeFromTokensPath(setup.tokensPath),
    showStatus: setup.showStatus,
    statusEl: setup.statusEl,
    store: storeWithFallback(),
    ui: {
      banner: document.getElementById("scanner-offline-banner"),
      queueLine: document.getElementById("scanner-offline-queue"),
      toggle: document.getElementById("scanner-offline-toggle"),
    },
  };

  /** The replay's messages. A queued check-in the server answers with
   * "already checked in" was checked in elsewhere: another door held the
   * same queued check-in. The sync names that out loud. An older cached
   * page without the sync wording keeps the door's usual words. */
  const syncMessages = (): ScanMessages => ({
    ...ctx.messages,
    messageAlreadyCheckedIn:
      ctx.message("OfflineSyncAlreadyCheckedIn") ||
      ctx.messages.messageAlreadyCheckedIn ||
      "",
  });

  const gate = replayGate();

  const maybeReplay = async (): Promise<void> => {
    const result = await gate.run({
      admitOne: setup.admitOne,
      messages: syncMessages(),
      onQueueChange: () => renderOffline(ctx),
      post: strictScannerPost(setup.post),
      scope: ctx.scope,
      store: ctx.store,
    });
    if (result && result.sent === 0 && result.waiting > 0) {
      ctx.showStatus(ctx.statusEl, ctx.message("OfflineSendFailed"), "error");
    }
    renderOffline(ctx);
  };

  const refreshHashes = async (): Promise<void> => {
    try {
      const res = await fetch(setup.tokensPath);
      const body = (await res.json()) as { hashes?: unknown };
      if (!Array.isArray(body.hashes)) return;
      saveHashList(
        ctx.store,
        ctx.scope,
        body.hashes.filter(
          (entry): entry is string => typeof entry === "string",
        ),
        Date.now(),
      );
    } catch {
      // A failed refresh keeps the list the door already saved. The next
      // online load tries again.
    }
  };

  const refreshThenPaint = async (): Promise<void> => {
    await refreshHashes();
    renderOffline(ctx);
  };

  if (ctx.ui.toggle) {
    ctx.ui.toggle.addEventListener("click", () => {
      setOfflineMode(
        ctx.store,
        ctx.scope,
        !offlineModeOn(ctx.store, ctx.scope),
      );
      renderOffline(ctx);
      void maybeReplay();
    });
  }
  window.addEventListener("online", () => {
    renderOffline(ctx);
    void refreshThenPaint();
    void maybeReplay();
  });

  void registerScannerServiceWorker(setup.serviceWorkerPath);
  void refreshThenPaint();
  renderOffline(ctx);

  return {
    replaying: gate.replaying,
    routeScan: () =>
      offlineModeOn(ctx.store, ctx.scope) ? "offline" : "online",
    scan: async (token) => {
      await settleOfflineScan(ctx, token);
      renderOffline(ctx);
    },
  };
};
