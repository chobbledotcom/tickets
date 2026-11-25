/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// test-groups: run-alone — the bundle runs inside happy-dom, whose internal
// task timers can outlive `happyDOM.abort()` under load; in a shared isolate a
// trailing timer fires during whichever suite runs next and fails its op
// sanitizer. Solo, it dies with the isolate — the proven-safe historical mode.

/**
 * The harness the scanner bundle tests share: the page the template renders,
 * a fresh happy-dom `Window` per test, and the built bundle loaded into it.
 *
 * The scanner is browser code: it initialises itself against `document` when
 * it loads. To exercise it in Deno we run the real built bundle (not the
 * source) inside a fresh happy-dom `Window` per test, so each case starts from
 * a clean DOM. The bundle's trailing `export { … }` is rewritten to stash the
 * functions on a global so the test can drive them (a function body can't
 * carry `export`).
 *
 * Running the real built bundle is deliberate: the precommit mutation gate
 * rebuilds that bundle per mutant, so these assertions bind to the code the
 * browser actually receives.
 */

import { expect } from "@std/expect";
import { afterEach } from "@std/testing/bdd";
import type { Stub } from "@std/testing/mock";
import {
  HTMLElement as HappyHTMLElement,
  type HTMLVideoElement as HappyHTMLVideoElement,
  Window,
} from "happy-dom";
import { fromBase64Url } from "#crypto/utils.ts";
import {
  type ScannerWords,
  type Wording,
  wordingOf,
} from "#shared/scanner-words.ts";
import { hmacHex } from "#shared/sha256.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { createGlobalStash, type GlobalStash } from "#test-utils/happy-dom.ts";
import { PAGE_WORDS, wordsAttribute, wordsWith } from "./words.ts";

const MODULE_MARKER = "__scannerModule";

/** How a test reports one outcome: the camera status's own painter. */
export type StatusSay = (
  text: string,
  type: "success" | "warning" | "error",
) => void;

export interface ScannerModule {
  admitScan: (
    scanPath: string,
    token: string,
    csrfToken: string,
    say: StatusSay,
    wording: Wording,
  ) => Promise<unknown>;
  extractToken: (data: string) => string | null;
  sayAnswer: (
    answer: Record<string, unknown>,
    wording: Wording,
    say: StatusSay,
  ) => void;
  showConfirm: (message: string) => Promise<boolean>;
  showStatus: (
    el: HappyHTMLElement,
    text: string,
    type: "success" | "warning" | "error",
  ) => void;
}

export interface ScannerHarness {
  cleanup(): Promise<void>;
  confirm: {
    close: HappyHTMLElement;
    message: HappyHTMLElement;
    no: HappyHTMLElement;
    yes: HappyHTMLElement;
  };
  document: Window["document"];
  module: ScannerModule;
  restore: () => void;
  /** Paint one outcome on the page's camera status. */
  say: StatusSay;
  /** The overwritten global scope, so a test can re-set the connection or
   * the local store before running the bundle again. */
  stash: GlobalStash;
  statusEl: HappyHTMLElement;
  video: HappyHTMLVideoElement;
  window: Window;
  wording: Wording;
}

/** The connection state a harness installs before the bundle runs. */
export interface ScannerGlobals {
  onLine?: boolean;
  /** Seed the page's local store before the bundle runs — a stored ticket
   * cache, a queued check-in, or a manual mode a reload would restore. */
  seed?: (store: Storage) => void;
}

/** The built bundle's export tail, rewritten as a global stash: esbuild emits
 * each export as `internal as name`, and the pair reads as an object entry —
 * `name: internal` — once the words around `as` swap places. A plain name
 * stays object shorthand for itself. The one QR read is rewritten onto a
 * stashed decoder, so a camera test feeds frames without bundling a second
 * copy of jsQR; with no decoder stashed the read answers no code, which is
 * what the confirm suites (that never decode) would see anyway. The
 * minifier's short names may carry a `$` (`$0`), so the matches read `[\w$]`. */
const runBundleOnce = (): void => {
  const bundle = Deno.readTextFileSync("src/ui/static/scanner.js")
    .replace(
      /export\s*\{([^}]*)\}\s*;?\s*$/,
      (_all, list: string) =>
        `;globalThis.${MODULE_MARKER}={${list
          .trim()
          .replace(/([\w$]+)\s+as\s+([\w$]+)/g, "$2: $1")}};`,
    )
    .replace(
      /let ([\w$]+)=[\w$]+\.default;if\(typeof \1!="function"\)/,
      'let $1=globalThis.__scannerJsqr||(()=>null);if(typeof $1!="function")',
    );
  new Function(bundle)();
};

/** The scanner page's own markup, as the template renders it: the messages
 * the container carries, the door's cache key, the camera, the status line,
 * the offline banner, the queue panel, the manual toggle, and the start
 * button. Suites that need a page the template did not render whole derive
 * their variant from this. */
export const SCANNER_PAGE = pageWith();

/** The scanner page carrying `words`. */
export function pageWith(words: ScannerWords = PAGE_WORDS): string {
  return `
  <meta name="csrf-token" content="csrf-page-token" />
  <div
    data-door-cache-key="dGVzdC1kb296LWNhY2hlLWtleQ"
    data-scan-operation-retention-days="7"
    data-scan-path="/admin/groups/5/scan"
    ${wordsAttribute(words)}
    id="scanner-container"
  >
    <aside class="hidden" id="scanner-offline-banner" role="status">
      <p id="scanner-offline-banner-text"></p>
    </aside>
    <video class="hidden" id="scanner-video" muted playsinline></video>
    <div class="hidden" id="scanner-status"></div>
    <div class="hidden" id="scanner-queue">
      <p aria-live="polite" id="scanner-queue-summary"></p>
      <ul id="scanner-queue-items"></ul>
    </div>
    <div class="hidden" id="scanner-quantity">
      <p id="scanner-quantity-message"></p>
      <select id="scanner-quantity-select"></select>
      <button id="scanner-quantity-confirm" type="button">Check in</button>
      <button id="scanner-quantity-cancel" type="button">Cancel</button>
    </div>
    <div id="scanner-confirm">
      <button id="scanner-confirm-close" type="button">×</button>
      <p id="scanner-confirm-message"></p>
      <button id="scanner-confirm-yes" type="button">Yes</button>
      <button id="scanner-confirm-no" type="button">No</button>
    </div>
  </div>
  <button id="scanner-start" type="button">Start Camera</button>
  <button aria-pressed="false" class="link-button muted" id="scanner-offline-toggle" type="button">Offline mode</button>
  <p class="hidden muted" id="scanner-offline-progress" role="status"></p>
  <form id="manual-checkin">
    <input aria-expanded="false" id="manual-checkin-input" role="combobox" type="text" />
    <div class="combobox-list hidden" id="ticket-options" role="listbox"></div>
    <div class="hidden" id="manual-checkin-status"></div>
    <button id="manual-checkin-submit" type="submit"><span>Search</span></button>
  </form>
`;
}

/** The camera page as the operator's ticket-to-booking rebrand renders it:
 * the rebrand rewrites the rendered catalog copy's prose only, so the
 * {tickets} holes the client fills keep their spelling. */
export const REBRANDED_PAGE = pageWith(
  wordsWith({
    checkedInPartial:
      "{name} checked in for {listingName} ({tickets} of {total} bookings)",
    noDoor: "This booking has no door to check in at.",
    notFound: "This booking was not found. Check that it is for this event.",
    selectQuantity: "How many bookings for {name}?",
    ticketCountOne: "{count} booking",
    ticketCountOther: "{count} bookings",
  }),
);

/** The page variant a template that renders no replay window would serve:
 * the client cannot bound its replay window, so the page refuses to start. */
export const SCANNER_PAGE_WITHOUT_REPLAY_WINDOW = SCANNER_PAGE.replace(
  '\n    data-scan-operation-retention-days="7"',
  "",
);

/** One element of the installed scanner page by id — the fixture always
 * carries it, so a miss is a broken page, not an empty answer. */
export const el = (
  document: Window["document"],
  id: string,
): HappyHTMLElement => {
  const found = document.getElementById(id);
  if (!(found instanceof HappyHTMLElement)) {
    throw new Error(`The scanner page carries no ${id}`);
  }
  return found;
};

/** Run the bundle again against the current page, the way a second script
 * tag would: a page the template did not render whole must not half-wire
 * the scanner. */
export const evaluateBundle = (): void => runBundleOnce();

export const useScanner = (
  page: string = SCANNER_PAGE,
  globals: ScannerGlobals = {},
): ScannerHarness => {
  const window = new Window({ url: "http://localhost/" });
  const document = window.document;
  document.body.innerHTML = page;
  const stash = createGlobalStash();
  stash.set("document", document);
  // The offline scanner reads the connection, the local store, and the
  // worker registry off the window's globals; the stashes give the bundle
  // the page's own pieces. Tests that need a dead connection or a queued
  // check-in replace the navigator or seed the store before they scan.
  stash.set("window", window);
  stash.set("localStorage", window.localStorage);
  stash.set("navigator", {
    onLine: globals.onLine ?? true,
    serviceWorker: { register: async () => ({}) },
  });
  globals.seed?.(window.localStorage);

  runBundleOnce();

  const module = (globalThis as Record<string, unknown>)[
    MODULE_MARKER
  ] as ScannerModule;
  const statusEl = el(document, "scanner-status");
  const wording = wordingOf(
    JSON.parse(String(el(document, "scanner-container").dataset.words)),
  );
  const video = document.querySelector("video");
  if (!video) throw new Error("The scanner page carries no scanner-video");

  return {
    cleanup: async (): Promise<void> => {
      await window.happyDOM.abort();
      window.close();
    },
    confirm: {
      close: el(document, "scanner-confirm-close"),
      message: el(document, "scanner-confirm-message"),
      no: el(document, "scanner-confirm-no"),
      yes: el(document, "scanner-confirm-yes"),
    },
    document,
    module,
    restore: (): void => {
      stash.restore();
      delete (globalThis as Record<string, unknown>)[MODULE_MARKER];
    },
    say: (text, type) => module.showStatus(statusEl, text, type),
    stash,
    statusEl,
    video,
    window,
    wording,
  };
};

/** The wiring both scanner suites share: one fresh page per test, and every
 * page torn down after it. Call inside a describe body. */
export const useScannerSuite = (
  page: string = SCANNER_PAGE,
): ((globals?: ScannerGlobals) => ScannerHarness) => {
  const harnesses: ScannerHarness[] = [];
  const fresh = (globals?: ScannerGlobals): ScannerHarness => {
    const h = useScanner(page, globals);
    harnesses.push(h);
    return h;
  };
  afterEach(async () => {
    for (const h of harnesses.splice(0)) {
      h.restore();
      await h.cleanup();
    }
  });
  return fresh;
};

/** Waits for an element to show the text: the hops after a confirm answer
 * are promise hops (the fetch stub answers in memory), so draining
 * microtasks until the text appears needs no clock. The bound turns text
 * that never shows into a failed assertion rather than a hung test. */
export const whenTextShows = async (
  target: HappyHTMLElement,
  text: string,
): Promise<void> => {
  for (let hops = 0; hops < 100 && target.textContent !== text; hops++) {
    await Promise.resolve();
  }
  expect(target.textContent).toBe(text);
};

export const whenMessageShows = (
  h: ScannerHarness,
  text: string,
): Promise<void> => whenTextShows(h.confirm.message, text);

/** The scan path the fixture page's camera posts to. */
export const SCAN_PATH = "/admin/groups/5/scan";

/** The store key that holds the fixture door's offline mode switch. */
export const MODE_KEY = `scanner-offline-mode-${SCAN_PATH}`;

/** The ticket token one scan carries. */
export const TOKEN = "tok12345";

/** The door key the fixture page's data attribute carries: the key the
 * camera fakes and the stored queue's digest digest under. */
export const DOOR_KEY = fromBase64Url("dGVzdC1kb296LWNhY2hlLWtleQ");

/** The queued check-in one reload would restore: the digest the door's
 * list holds for the token one scan carries, the delivery id it answers
 * by, and the one person it admits. The check-in went in a moment ago, so
 * the door's replay window still covers it. */
export const queuedItem = {
  operationId: "018f3c2e-1b7d-7f31-9d4a-2f5c8e6a9b30",
  quantity: 1,
  queuedAt: Date.now() - 1000,
  scanPath: SCAN_PATH,
  tokenHash: await hmacHex(DOOR_KEY, TOKEN),
};

/** The store's queue, as the page wrote it. */
export const storedQueue = (h: ScannerHarness): string | null =>
  h.window.localStorage.getItem("scanner-queue");

/** The store of a full device: every write to it fails the way a browser
 * refuses a write past the site's quota. */
export const fullStore = (h: ScannerHarness): void => {
  const refuse = () => {
    throw new DOMException("The store is full", "QuotaExceededError");
  };
  h.stash.set(
    "localStorage",
    Object.create(h.window.localStorage, {
      removeItem: { value: refuse },
      setItem: { value: refuse },
    }),
  );
};

const wrongDoor = (): Response =>
  Response.json({
    listingName: "Standard",
    name: "Ada",
    status: "wrong_listing",
  });

/** A wrong-door scan the organiser overrides: reads the scan, takes the
 * override, and hands the caller the finished scan's promise and the fetch
 * stub (dispose it with `using`). The forced rescan answers `afterForce`. */
export const forcedScan = async (
  h: ScannerHarness,
  ...afterForce: Response[]
): Promise<{ done: Promise<unknown>; fetchStub: Stub }> => {
  const fetchStub = stubFetch(wrongDoor(), ...afterForce);
  const done = h.module.admitScan(
    "/admin/groups/5/scan",
    "tok",
    "csrf",
    h.say,
    h.wording,
  );
  await whenMessageShows(
    h,
    'Ada is registered for "Standard", not this listing. Check in anyway?',
  );
  h.confirm.yes.click();
  return { done, fetchStub };
};

/** A forced scan whose answer is verify_id: a ticket on another door of a
 * non-transferable listing. Waits at the ID prompt. */
export const forcedVerifyScan = async (h: ScannerHarness) => {
  const forced = await forcedScan(
    h,
    Response.json({ name: "Ada", status: "verify_id" }),
    Response.json({
      listingName: "Standard",
      name: "Ada",
      quantity: 1,
      remaining: 0,
      status: "checked_in",
      total: 1,
    }),
  );
  await whenMessageShows(h, 'Does their ID match "Ada"?');
  return forced;
};

/** A forced scan of a ticket whose only rows are "No check-in": the
 * override still finds no door. */
export const forcedNoDoorScan = (h: ScannerHarness) =>
  forcedScan(h, wrongDoor());
