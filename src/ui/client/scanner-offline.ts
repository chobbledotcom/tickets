/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

/**
 * The scanner page's offline mode, wired onto one door: the saved digest
 * list, the queue counter, the banner, the manual switch, and the replay
 * triggers. The store rules behind it live in scanner-door-store.ts.
 */

import { hmacHex } from "#crypto/sha256.ts";
import { filter } from "#fp";
import {
  type DoorScope,
  dropQueuedCheckIn,
  type KeyValueStore,
  mapStoreOver,
  offlineModeOn,
  type QueuedCheckIn,
  queueCheckIn,
  queuedCheckIns,
  savedHashList,
  saveHashList,
  scopeFromTokensPath,
  setOfflineMode,
} from "./scanner-door-store.ts";

/** Fill the `{name}`-style holes in a message template. */
export const interpolate = (
  template: string,
  values: Record<string, string | number>,
): string =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));

/** The bytes a base64url text carries, as the door's cache key travels on
 * the page. atob reads only the standard base64 alphabet. The URL-safe
 * letters return to the standard ones, and the padding returns with them. */
const fromBase64UrlBytes = (text: string): Uint8Array => {
  const base64 = text.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(`${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

/** The door's cache key bytes the page carries. A page without the key
 * cannot digest a scan against its saved list. A missing key therefore
 * stops the wire-up instead of half-wiring the offline mode. */
const doorCacheKeyBytes = (doorCacheKey: string): Uint8Array => {
  if (doorCacheKey === "") {
    throw new Error("No door cache key on the scanner page");
  }
  return fromBase64UrlBytes(doorCacheKey);
};

/** One answer the scan API can give: a status the door reads, plus the
 * facts that answer carries. */
export type ScanAnswer = { status: string; [key: string]: unknown };

/** The scan POST a scan or a replay runs. The body names the person by
 * ticket token (a live scan) or by the token digest the device stored (a
 * replay). The door's choices ride along. */
export type ScanPost = (
  scanPath: string,
  token: string,
  csrfToken: string,
  choices?: Record<string, unknown>,
) => Promise<ScanAnswer>;

/** The statuses the scan API speaks. Anything else — a login page, a bare
 * error envelope — is not a scan answer. A replay must not treat such a
 * body as a door answer and drop the check-in. */
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

/** The scan POST a replay trusts: only real scan answers pass. Any other
 * body means the check-in did not land, so the replay stops and the
 * check-in stays queued. */
export const strictScannerPost =
  (post: ScanPost): ScanPost =>
  async (...args) => {
    const answer = await post(...args);
    if (!(answer.status in SCAN_ANSWER_STATUS)) {
      throw new Error(`Not a scan answer: ${JSON.stringify(answer)}`);
    }
    return answer;
  };

/** The page's messages, as the container's data attributes carry them. */
export type ScanMessages = Record<string, string>;

/** The container's data attributes as plain messages. An attribute a page
 * did not carry reads as absent, not as an empty word. */
const datasetMessages = (container: HTMLElement): ScanMessages => {
  const messages: ScanMessages = {};
  for (const [name, value] of Object.entries(container.dataset)) {
    if (value !== undefined) messages[name] = value;
  }
  return messages;
};

/** One full live admission of one queued check-in: its digest, the
 * replay's post, and the replay's messages. The page owns the flow, its
 * asks included. The offline mode owns what the post sends and what the
 * messages say. The answer the admission settled on comes back, so the
 * replay can say which check-ins the door had already taken. */
export type AdmitOne = (
  tokenHash: string,
  post: ScanPost,
  messages: ScanMessages,
) => Promise<ScanAnswer>;

/** What one replay run did: how many check-ins sent, how many still wait,
 * and the names of the ones the door had already taken elsewhere. */
export type ReplayOutcome = {
  sent: number;
  waiting: number;
  duplicates: string[];
};

/** The post one queued delivery runs. It carries the delivery's own
 * operation id on every send, first try and re-ask alike. A retry of the
 * same delivery therefore claims nothing the server already took. */
const replayPost =
  (post: ScanPost, delivery: QueuedCheckIn): ScanPost =>
  (scanPath, token, csrfToken, choices) =>
    post(scanPath, token, csrfToken, {
      ...choices,
      operationId: delivery.operationId,
    });

/** Send every queued check-in, oldest first, through the page's live
 * admission flow. A check-in leaves the queue only after its admission
 * finished for good — a door answer, or the door's own skip. The first
 * send that cannot reach the server stops the run, and the rest stay
 * queued. Every check-in the door had already taken elsewhere comes back
 * by name, so the sync can say so for each of them. */
export const replayQueuedCheckIns = async (deps: {
  admitOne: AdmitOne;
  messages: ScanMessages;
  onQueueChange?: () => void;
  post: ScanPost;
  scope: DoorScope;
  store: KeyValueStore;
}): Promise<ReplayOutcome> => {
  let sent = 0;
  const duplicates: string[] = [];
  for (const delivery of queuedCheckIns(deps.store, deps.scope)) {
    try {
      const answer = await deps.admitOne(
        delivery.tokenHash,
        replayPost(deps.post, delivery),
        deps.messages,
      );
      if (
        answer.status === "already_checked_in" &&
        typeof answer.name === "string"
      ) {
        duplicates.push(answer.name);
      }
    } catch {
      // The server was out of reach: the digest stays queued for the next
      // run, and nothing else sends this turn.
      break;
    }
    dropQueuedCheckIn(deps.store, deps.scope, delivery.operationId);
    sent += 1;
    deps.onQueueChange?.();
  }
  return {
    duplicates,
    sent,
    waiting: queuedCheckIns(deps.store, deps.scope).length,
  };
};

/** One replay at a time: a second trigger while one runs stands down, so
 * two queued sends can never race each other. Each page owns its own
 * gate. */
export const replayGate = () => {
  let running = false;
  return {
    replaying: (): boolean => running,
    run: async (
      deps: Parameters<typeof replayQueuedCheckIns>[0],
    ): Promise<ReplayOutcome | null> => {
      if (running) return null;
      running = true;
      try {
        return await replayQueuedCheckIns(deps);
      } finally {
        running = false;
      }
    },
  };
};

/** The storage the offline rules read and write. Storage can be full or
 * blocked. The door then works from memory for this page visit, and the
 * queue lives as long as the page does. */
const storeWithFallback = (): KeyValueStore => {
  try {
    localStorage.setItem("scanner:probe", "1");
    localStorage.removeItem("scanner:probe");
    return localStorage;
  } catch {
    return mapStoreOver(new Map());
  }
};

/** One status line write, worded the way the page's own status writer does
 * it: text plus the scanner-status-{kind} class. */
export type StatusWriter = (
  el: HTMLElement,
  text: string,
  kind: string,
) => void;

/** The page's offline elements, resolved once at setup. The banner and the
 * queue line sit inside the camera container. The switch sits beside the
 * start button. All three ids are page-unique. An older cached page can
 * lack any of them. */
type OfflineUi = {
  banner: HTMLElement | null;
  queueLine: HTMLElement | null;
  toggle: HTMLElement | null;
};

/** Everything one page's offline mode reads and drives, resolved once. */
type OfflineContext = {
  /** The names of the queued check-ins the last sync found were already
   * checked in elsewhere. Empty until a sync says so, and a sync that
   * delivers check-ins replaces the story whole. */
  duplicates: string[];
  /** The door's cache key bytes, decoded once at wire-up. Every scan
   * digests under it, so its digests match the saved list's. */
  doorKey: Uint8Array;
  message: (name: string) => string;
  messages: ScanMessages;
  scope: DoorScope;
  showStatus: StatusWriter;
  statusEl: HTMLElement;
  store: KeyValueStore;
  ui: OfflineUi;
};

/** Paint the waiting line. It counts the check-ins that still wait to
 * send. It also names the ones the last sync found were already checked
 * in elsewhere, so neither fact is lost while the door reads the page. */
const renderWaitingLine = (ctx: OfflineContext): void => {
  if (!ctx.ui.queueLine) return;
  const waiting = queuedCheckIns(ctx.store, ctx.scope).length;
  const waitingSentence =
    waiting === 0
      ? ""
      : interpolate(
          ctx.message(waiting === 1 ? "OfflineQueueOne" : "OfflineQueueOther"),
          { count: waiting },
        );
  const duplicateSentence =
    ctx.duplicates.length === 0
      ? ""
      : interpolate(
          ctx.message(
            ctx.duplicates.length === 1
              ? "OfflineDuplicatesOne"
              : "OfflineDuplicatesOther",
          ),
          {
            count: ctx.duplicates.length,
            names: ctx.duplicates.join(", "),
          },
        );
  const line = filter((part: string) => part !== "")([
    waitingSentence,
    duplicateSentence,
  ]).join(" ");
  ctx.ui.queueLine.classList.toggle("hidden", line === "");
  ctx.ui.queueLine.textContent = line;
};

/** Paint the whole offline UI from the door's stored state. The banner
 * shows while the door works offline, and the switch carries its state. */
const renderOffline = (ctx: OfflineContext): void => {
  const modeOn = offlineModeOn(ctx.store, ctx.scope);
  if (ctx.ui.banner) {
    ctx.ui.banner.classList.toggle("hidden", !modeOn);
  }
  if (ctx.ui.toggle) {
    ctx.ui.toggle.setAttribute("aria-pressed", String(modeOn));
    ctx.ui.toggle.textContent = ctx.message(
      modeOn ? "OfflineToggleOn" : "OfflineToggleOff",
    );
  }
  renderWaitingLine(ctx);
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
  const tokenHash = await hmacHex(ctx.doorKey, token);
  if (saved.has(tokenHash)) {
    // Every queueing is one delivery: a party's next arrival of one
    // ticket queues again, and the server answers one delivery once.
    queueCheckIn(ctx.store, ctx.scope, tokenHash, Date.now());
    ctx.showStatus(ctx.statusEl, ctx.message("OfflineScanSaved"), "warning");
  } else {
    ctx.showStatus(ctx.statusEl, ctx.message("OfflineScanUnknown"), "error");
  }
};

/** Everything the scanner page hands the offline mode. */
export type OfflineScannerSetup = {
  /** One full live admission for one queued check-in. The page owns the
   * flow. The offline mode owns what the post sends. */
  admitOne: AdmitOne;
  container: HTMLElement;
  /** The door's cache key the page carries: base64url bytes the device
   * decodes once and digests every scan under. The saved list holds
   * digests under the same key, so a list copied off the device digests
   * nothing by itself. */
  doorCacheKey: string;
  /** The page's post for a replay: it names the person by token digest,
   * because the device never held the token. */
  post: ScanPost;
  showStatus: StatusWriter;
  statusEl: HTMLElement;
  tokensPath: string;
};

/** What the scanner's scan loop reads to decide where a scan goes. The
 * wiring branch exports the type with the page that reads it. */
type OfflineScanner = {
  /** Send the waiting check-ins now. A replay that is already running
   * stands down, and an empty queue sends nothing. */
  replay: () => Promise<void>;
  /** A replay is sending queued check-ins, so the camera stands down. */
  replaying: () => boolean;
  /** Where the next scan goes: straight to the saved list ("offline"), or
   * through the server ("online"). The manual switch decides. */
  routeScan: () => "offline" | "online";
  /** Check one scanned token against the saved list and either queue its
   * check-in or say why the door cannot take it. */
  scan: (token: string) => Promise<void>;
};

/** Wire the offline mode onto one scanner page. The saved list loads when
 * the connection is there. The queue sends whenever the door proves the
 * connection. The switch decides where the next scan goes. */
export const setupOfflineScanner = (
  setup: OfflineScannerSetup,
): OfflineScanner => {
  const ctx: OfflineContext = {
    doorKey: doorCacheKeyBytes(setup.doorCacheKey),
    duplicates: [],
    message: (name) => setup.container.dataset[`message${name}`] ?? "",
    messages: datasetMessages(setup.container),
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
   * same queued check-in. The sync names that out loud, per check-in. An
   * older cached page without the sync wording keeps the door's usual
   * words. */
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
    if (result && result.sent > 0) {
      // A sync that delivers check-ins replaces the last story whole. An
      // empty run sends nothing, so the last story stands.
      ctx.duplicates = result.duplicates;
    }
    if (result && result.sent === 0 && result.waiting > 0) {
      ctx.showStatus(ctx.statusEl, ctx.message("OfflineSendFailed"), "error");
    }
    renderOffline(ctx);
  };

  const refreshHashes = async (): Promise<boolean> => {
    try {
      const res = await fetch(setup.tokensPath);
      const body = (await res.json()) as { hashes?: unknown };
      if (!Array.isArray(body.hashes)) return false;
      saveHashList(
        ctx.store,
        ctx.scope,
        body.hashes.filter(
          (entry): entry is string => typeof entry === "string",
        ),
        Date.now(),
      );
      return true;
    } catch {
      // A failed refresh keeps the list the door already saved. The next
      // online load tries again.
      return false;
    }
  };

  /** Load the saved list fresh, then repaint. A list that arrives proves
   * the connection, so the waiting check-ins send while the door is
   * here. */
  const refreshThenReplay = async (): Promise<void> => {
    const loaded = await refreshHashes();
    renderOffline(ctx);
    if (loaded) await maybeReplay();
  };

  if (ctx.ui.toggle) {
    ctx.ui.toggle.addEventListener("click", () => {
      const wasOn = offlineModeOn(ctx.store, ctx.scope);
      setOfflineMode(ctx.store, ctx.scope, !wasOn);
      renderOffline(ctx);
      // Back in online mode, the door can send what it saved. An event
      // cannot always announce the connection is back, so the switch back
      // tries here.
      if (wasOn) void maybeReplay();
    });
  }
  window.addEventListener("online", () => {
    renderOffline(ctx);
    void refreshThenReplay();
    void maybeReplay();
  });

  void refreshThenReplay();
  renderOffline(ctx);

  return {
    replay: maybeReplay,
    replaying: gate.replaying,
    routeScan: () => {
      if (offlineModeOn(ctx.store, ctx.scope)) return "offline";
      return "online";
    },
    scan: async (token) => {
      await settleOfflineScan(ctx, token);
      renderOffline(ctx);
    },
  };
};
