/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

/**
 * The scanner's offline mode: the door's saved ticket list, the queue of
 * check-ins waiting to send, and the on/off switch.
 *
 * The rules are pure functions over a key-value store. The browser shell
 * (localStorage, fetch, DOM) stays thin around them, so tests drive the real
 * rules with a fake store.
 */

import { unique } from "#fp";
import { storedArray } from "./stored-array.ts";

/** The storage the offline rules read and write. localStorage-shaped, so a
 * test can hand the rules a Map-backed fake. */
export type KeyValueStore = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

/** One door a scanner page works: a single listing, or a whole group. */
export type DoorScope =
  | { kind: "listing"; id: number }
  | { kind: "group"; id: number };

/** Read the door out of the page's token-list URL. A wrong-shaped path is a
 * broken page, so the caller throws rather than half-wire offline mode. */
export const scopeFromTokensPath = (path: string): DoorScope => {
  const match = path.match(/^\/admin\/(listing|groups)\/(\d+)\/scan-tokens$/);
  if (!match) throw new Error(`No door scope in token path: ${path}`);
  return match[1] === "listing"
    ? { id: Number(match[2]), kind: "listing" }
    : { id: Number(match[2]), kind: "group" };
};

/** The three storage slots one door's offline mode uses, named once so the
 * readers and writers can never drift apart. */
const storageKeys = (
  scope: DoorScope,
): {
  mode: string;
  queue: string;
  tokens: string;
} => ({
  mode: `scanner:offline:${scope.kind}-${scope.id}`,
  queue: `scanner:queue:${scope.kind}-${scope.id}`,
  tokens: `scanner:tokens:${scope.kind}-${scope.id}`,
});

const parseStringArray = (raw: string | null): string[] => {
  try {
    return storedArray(
      raw,
      (entry): entry is string => typeof entry === "string",
    );
  } catch {
    // A value another version wrote reads as absent here. The next online
    // load replaces the list whole.
    return [];
  }
};

/** Replace the door's saved ticket list with the list the server just sent. */
export const saveTokenList = (
  store: KeyValueStore,
  scope: DoorScope,
  tokens: readonly string[],
): void => {
  store.setItem(
    storageKeys(scope).tokens,
    JSON.stringify(unique([...tokens]).sort()),
  );
};

/** The door's saved ticket list, for a scan to check against. */
export const savedTokenList = (
  store: KeyValueStore,
  scope: DoorScope,
): Set<string> =>
  new Set(parseStringArray(store.getItem(storageKeys(scope).tokens)));

/** The check-ins waiting to send, oldest first. */
export const queuedCheckIns = (
  store: KeyValueStore,
  scope: DoorScope,
): string[] => parseStringArray(store.getItem(storageKeys(scope).queue));

/** Add a check-in to the queue. A token already queued stays single, so a
 * double scan offline cannot send one ticket twice. Answers false then. */
export const queueCheckIn = (
  store: KeyValueStore,
  scope: DoorScope,
  token: string,
): boolean => {
  const queue = queuedCheckIns(store, scope);
  if (queue.includes(token)) return false;
  store.setItem(storageKeys(scope).queue, JSON.stringify([...queue, token]));
  return true;
};

/** Take one check-in out of the queue. The door calls this only after the
 * server answered the scan for good. */
export const dropQueuedCheckIn = (
  store: KeyValueStore,
  scope: DoorScope,
  token: string,
): void => {
  const queue = queuedCheckIns(store, scope).filter((entry) => entry !== token);
  store.setItem(storageKeys(scope).queue, JSON.stringify(queue));
};

/** The manual switch's stored state. Absent means off. */
export const offlineModeOn = (
  store: KeyValueStore,
  scope: DoorScope,
): boolean => store.getItem(storageKeys(scope).mode) === "on";

/** Store the manual switch's state. Off removes the key, so the door's
 * storage carries no stale "on". */
export const setOfflineMode = (
  store: KeyValueStore,
  scope: DoorScope,
  on: boolean,
): void => {
  if (on) store.setItem(storageKeys(scope).mode, "on");
  else store.removeItem(storageKeys(scope).mode);
};

/** Fill the `{name}`-style holes in a message template. */
export const interpolate = (
  template: string,
  values: Record<string, string | number>,
): string =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));

/** The statuses the scan API speaks. Anything else (a login page, a bare
 * error object) is not a scan answer. A replay must not treat such a body
 * as one door answer and drop the check-in. */
const SCAN_ANSWER_STATUS: Record<string, true> = {
  already_checked_in: true,
  checked_in: true,
  error: true,
  not_found: true,
  refunded: true,
  select_quantity: true,
  verify_id: true,
  wrong_listing: true,
};

export type ScanAnswer = { status: string; [key: string]: unknown };

export type ScanPost = (
  scanPath: string,
  token: string,
  csrfToken: string,
  choices?: { force?: boolean; idVerified?: boolean; quantity?: number },
) => Promise<ScanAnswer>;

/** The scan answers a replay trusts: only the statuses the scan API really
 * speaks. Any other body means the check-in did not land, so the replay
 * stops and the token stays queued. */
export const strictScannerPost =
  (post: ScanPost): ScanPost =>
  async (...args) => {
    const answer = await post(...args);
    if (!(answer.status in SCAN_ANSWER_STATUS)) {
      throw new Error(`Not a scan answer: ${JSON.stringify(answer)}`);
    }
    return answer;
  };

/** Send every queued check-in, oldest first, through the page's live
 * admission flow, its asks included. One token gets one turn. A token
 * leaves the queue only after its admission finished for good. The first
 * send that cannot reach the server stops the run, and the rest stay
 * queued. */
export const replayQueuedCheckIns = async (deps: {
  store: KeyValueStore;
  scope: DoorScope;
  admitOne: (token: string) => Promise<void>;
  onQueueChange?: (waiting: number) => void;
}): Promise<{ sent: number; waiting: number }> => {
  let sent = 0;
  for (const token of queuedCheckIns(deps.store, deps.scope)) {
    try {
      await deps.admitOne(token);
    } catch {
      // The server was out of reach: the token stays queued for the next
      // run, and nothing else sends this turn.
      break;
    }
    dropQueuedCheckIn(deps.store, deps.scope, token);
    sent += 1;
    deps.onQueueChange?.(queuedCheckIns(deps.store, deps.scope).length);
  }
  return { sent, waiting: queuedCheckIns(deps.store, deps.scope).length };
};

let replayRunning = false;

/** One replay at a time: a second trigger while one runs stands down, so
 * two queued sends can never race each other. */
export const runReplay = async (
  deps: Parameters<typeof replayQueuedCheckIns>[0],
): Promise<{ sent: number; waiting: number } | null> => {
  if (replayRunning) return null;
  replayRunning = true;
  try {
    return await replayQueuedCheckIns(deps);
  } finally {
    replayRunning = false;
  }
};

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
  scope: DoorScope;
  showStatus: StatusWriter;
  statusEl: HTMLElement;
  store: KeyValueStore;
  ui: OfflineUi;
};

/** Paint the whole offline UI from the door's stored state. The banner
 * shows while the door works offline. The switch carries its state. The
 * waiting line speaks in the door's own words. */
const renderOffline = (ctx: OfflineContext, sendFailed: boolean): void => {
  const modeOn = offlineModeOn(ctx.store, ctx.scope);
  const waiting = queuedCheckIns(ctx.store, ctx.scope).length;
  if (ctx.ui.banner) {
    ctx.ui.banner.classList.toggle("hidden", !(modeOn || sendFailed));
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
const recordOfflineScan = (ctx: OfflineContext, token: string): void => {
  if (savedTokenList(ctx.store, ctx.scope).has(token)) {
    queueCheckIn(ctx.store, ctx.scope, token);
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
  /** One full live admission for one token, asks included. */
  admitOne: (token: string) => Promise<void>;
  /** The page's own scan POST, wrapped here for replay trust. */
  post: ScanPost;
};

/** What the scanner's scan loop reads to decide where a scan goes. */
export type OfflineScanner = {
  /** Where the next scan goes: straight to the saved list ("offline"), or
   * through the server ("online"). The manual switch sends every scan
   * offline. After a failed send, the door goes offline again only when
   * the device itself says it has no connection. A server that comes back
   * without a network event is found by the very next scan. */
  routeScan: (token: string) => "offline" | "online";
  /** A replay is sending queued check-ins, so the camera stands down. */
  replaying: () => boolean;
  /** Check one scanned token against the saved list and either queue its
   * check-in or say why the door cannot take it. */
  scan: (token: string) => void;
  /** A send just failed: keep the scan from the saved list, and show the
   * offline banner until a send succeeds or the connection returns. */
  scanAfterFailedSend: (token: string) => void;
  /** A send reached the server: the door works online again, and a token
   * from the failed send is now delivered, so it leaves the queue. */
  noteScanSent: (token: string) => void;
};

/** Wire the offline mode onto one scanner page: the saved list, the queue
 * counter, the banner, the manual switch, and the replay triggers. */
export const setupOfflineScanner = (
  setup: OfflineScannerSetup,
): OfflineScanner => {
  const ctx: OfflineContext = {
    message: (name) => setup.container.dataset[`message${name}`] ?? "",
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

  let sendFailed = false;

  const maybeReplay = (): Promise<void> =>
    runReplay({
      admitOne: setup.admitOne,
      onQueueChange: () => renderOffline(ctx, sendFailed),
      scope: ctx.scope,
      store: ctx.store,
    }).then((result) => {
      if (result && result.sent === 0 && result.waiting > 0) {
        ctx.showStatus(ctx.statusEl, ctx.message("OfflineSendFailed"), "error");
      }
      renderOffline(ctx, sendFailed);
    });

  const refreshTokens = async (): Promise<void> => {
    try {
      const res = await fetch(setup.tokensPath);
      const body = (await res.json()) as { tokens?: unknown };
      if (!Array.isArray(body.tokens)) return;
      saveTokenList(
        ctx.store,
        ctx.scope,
        body.tokens.filter(
          (entry): entry is string => typeof entry === "string",
        ),
      );
    } catch {
      // A failed refresh keeps the list the door already saved. The next
      // online load tries again.
    }
  };

  if (ctx.ui.toggle) {
    ctx.ui.toggle.addEventListener("click", () => {
      setOfflineMode(
        ctx.store,
        ctx.scope,
        !offlineModeOn(ctx.store, ctx.scope),
      );
      renderOffline(ctx, sendFailed);
      void maybeReplay();
    });
  }
  window.addEventListener("online", () => {
    sendFailed = false;
    renderOffline(ctx, sendFailed);
    void maybeReplay();
  });

  void registerScannerServiceWorker(setup.serviceWorkerPath);
  void refreshTokens().finally(() => renderOffline(ctx, sendFailed));
  renderOffline(ctx, sendFailed);

  return {
    noteScanSent: (token) => {
      sendFailed = false;
      dropQueuedCheckIn(ctx.store, ctx.scope, token);
      renderOffline(ctx, sendFailed);
    },
    replaying: () => replayRunning,
    routeScan: () =>
      offlineModeOn(ctx.store, ctx.scope) ||
      (sendFailed && navigator.onLine === false)
        ? "offline"
        : "online",
    scan: (token) => {
      recordOfflineScan(ctx, token);
      renderOffline(ctx, sendFailed);
    },
    scanAfterFailedSend: (token) => {
      sendFailed = true;
      renderOffline(ctx, sendFailed);
      recordOfflineScan(ctx, token);
      renderOffline(ctx, sendFailed);
    },
  };
};
