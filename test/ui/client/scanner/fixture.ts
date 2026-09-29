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
import { Window } from "happy-dom";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { createGlobalStash } from "#test-utils/happy-dom.ts";

const MODULE_MARKER = "__scannerModule";

export interface ScannerModule {
  answerScan: (
    el: HTMLElement,
    result: Record<string, unknown>,
    messages: Record<string, string>,
    post: (choices?: {
      force?: boolean;
      idVerified?: boolean;
    }) => Promise<Record<string, unknown>>,
    confirmed?: { force?: boolean; idVerified?: boolean },
  ) => Promise<void>;
  extractToken: (data: string) => string | null;
  handleResult: (
    el: HTMLElement,
    result: Record<string, unknown>,
    messages: Record<string, string>,
  ) => void;
  postScan: (
    scanPath: string,
    token: string,
    csrfToken: string,
    choices?: { force?: boolean; idVerified?: boolean },
  ) => Promise<Record<string, unknown>>;
  showConfirm: (message: string) => Promise<boolean>;
}

export interface ScannerHarness {
  cleanup(): Promise<void>;
  confirm: {
    close: HTMLElement;
    message: HTMLElement;
    no: HTMLElement;
    yes: HTMLElement;
  };
  document: Window["document"];
  messages: Record<string, string>;
  module: ScannerModule;
  restore: () => void;
  statusEl: HTMLElement;
  video: HTMLVideoElement;
  window: Window;
}

/** The built bundle's export tail, rewritten as a global stash: esbuild emits
 * each export as `internal as name`, and the pair reads as an object entry —
 * `name: internal` — once the words around `as` swap places. A plain name
 * stays object shorthand for itself. */
const runBundleOnce = (): void => {
  const bundle = Deno.readTextFileSync("src/ui/static/scanner.js").replace(
    /export\s*\{([^}]*)\}\s*;?\s*$/,
    (_all, list: string) =>
      `;globalThis.${MODULE_MARKER}={${list
        .trim()
        .replace(/(\w+)\s+as\s+(\w+)/g, "$2: $1")}};`,
  );
  new Function(bundle)();
};

/** The scanner page's own markup, as the template renders it: the messages
 * the container carries, the camera, the status line, and the start button. */
const SCANNER_PAGE = `
  <meta name="csrf-token" content="csrf-page-token" />
  <div
    data-message-already-checked-in="{name} already checked in for {listingName} ({tickets})"
    data-message-checked-in="{name} checked in for {listingName} ({tickets})"
    data-message-camera-denied="Camera access denied"
    data-message-error="Error"
    data-message-id-mismatch="ID does not match {name}"
    data-message-invalid-qr="Invalid QR code"
    data-message-network-error="Network error"
    data-message-no-door="This ticket has no door to check in at"
    data-message-not-found="Ticket not found"
    data-message-refunded="{name} has been refunded"
    data-message-scanning="Scanning..."
    data-message-skipped="Skipped {name}"
    data-message-ticket-count-one="{count} ticket"
    data-message-ticket-count-other="{count} tickets"
    data-message-verify-id-confirm="Does their ID match {name}?"
    data-message-wrong-listing-confirm="{name} is registered for {listingName}. Check in anyway?"
    id="scanner-container"
  >
    <video data-scan-path="/admin/groups/5/scan" id="scanner-video" muted playsinline></video>
    <div id="scanner-status"></div>
    <div id="scanner-confirm">
      <button id="scanner-confirm-close" type="button">×</button>
      <p id="scanner-confirm-message"></p>
      <button id="scanner-confirm-yes" type="button">Yes</button>
      <button id="scanner-confirm-no" type="button">No</button>
    </div>
  </div>
  <button id="scanner-start" type="button">Start Camera</button>
`;

/** One element of the installed scanner page by id — the fixture always
 * carries it, so a miss is a broken page, not an empty answer. */
export const el = (document: Window["document"], id: string): HTMLElement => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`The scanner page carries no ${id}`);
  return found as unknown as HTMLElement;
};

export const useScanner = (): ScannerHarness => {
  const window = new Window({ url: "http://localhost/" });
  const document = window.document;
  document.body.innerHTML = SCANNER_PAGE;
  const stash = createGlobalStash();
  stash.set("document", document);

  runBundleOnce();

  const module = (globalThis as Record<string, unknown>)[
    MODULE_MARKER
  ] as ScannerModule;
  const messages = el(document, "scanner-container")
    .dataset as unknown as Record<string, string>;

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
    messages,
    module,
    restore: (): void => {
      stash.restore();
      delete (globalThis as Record<string, unknown>)[MODULE_MARKER];
    },
    statusEl: el(document, "scanner-status"),
    video: el(document, "scanner-video") as unknown as HTMLVideoElement,
    window,
  };
};

/** The wiring both scanner suites share: one fresh page per test, and every
 * page torn down after it. Call inside a describe body. */
export const useScannerSuite = (): (() => ScannerHarness) => {
  const harnesses: ScannerHarness[] = [];
  const fresh = (): ScannerHarness => {
    const h = useScanner();
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
  target: HTMLElement,
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
): Promise<{ done: Promise<void>; fetchStub: Stub }> => {
  const fetchStub = stubFetch(wrongDoor(), ...afterForce);
  const post = (choices?: { force?: boolean; idVerified?: boolean }) =>
    h.module.postScan("/admin/groups/5/scan", "tok", "csrf", choices);
  const done = h.module.answerScan(h.statusEl, await post(), h.messages, post);
  await whenMessageShows(h, "Ada is registered for Standard. Check in anyway?");
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
      status: "checked_in",
    }),
  );
  await whenMessageShows(h, "Does their ID match Ada?");
  return forced;
};

/** A forced scan of a ticket whose only rows are "No check-in": the
 * override still finds no door. */
export const forcedNoDoorScan = (h: ScannerHarness) =>
  forcedScan(h, wrongDoor());
