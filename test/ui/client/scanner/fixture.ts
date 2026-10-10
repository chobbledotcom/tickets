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
import { rebrandedPage } from "#test-utils/rebrand-page.ts";

const MODULE_MARKER = "__scannerModule";

export interface ScannerModule {
  admitScan: (
    scanPath: string,
    token: string,
    csrfToken: string,
    statusEl: HTMLElement,
    messages: Record<string, string>,
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
    choices?: { force?: boolean; idVerified?: boolean; quantity?: number },
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
 * stays object shorthand for itself. The one QR read is rewritten onto a
 * stashed decoder, so a camera test feeds frames without bundling a second
 * copy of jsQR; with no decoder stashed the read answers no code, which is
 * what the confirm suites (that never decode) would see anyway. */
const runBundleOnce = (): void => {
  const bundle = Deno.readTextFileSync("src/ui/static/scanner.js")
    .replace(
      /export\s*\{([^}]*)\}\s*;?\s*$/,
      (_all, list: string) =>
        `;globalThis.${MODULE_MARKER}={${list
          .trim()
          .replace(/(\w+)\s+as\s+(\w+)/g, "$2: $1")}};`,
    )
    .replace(
      /\(0,(\w+)\.default\)\((\w+)\.data,\2\.width,\2\.height\)/,
      "(0,globalThis.__scannerJsqr||(() => null))($2.data,$2.width,$2.height)",
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
    data-message-checked-in-partial="{name} checked in for {listingName} ({tickets} of {total} tickets)"
    data-message-camera-denied="Camera access denied"
    data-message-error="Error"
    data-message-id-mismatch="ID does not match {name}"
    data-message-invalid-qr="Invalid QR code"
    data-message-network-error="Network error"
    data-message-no-door="This ticket has no door to check in at."
    data-message-not-found="Ticket not found"
    data-message-refunded="{name} has been refunded"
    data-message-scanning="Scanning..."
    data-message-select-quantity="How many tickets for {name}?"
    data-message-skipped="Skipped {name}"
    data-message-ticket-count-one="{count} ticket"
    data-message-ticket-count-other="{count} tickets"
    data-message-verify-id-confirm="Does their ID match &quot;{name}&quot;?"
    data-message-wrong-listing-confirm="{name} is registered for &quot;{listingName}&quot;, not this listing. Check in anyway?"
    id="scanner-container"
  >
    <video class="hidden" data-scan-path="/admin/groups/5/scan" id="scanner-video" muted playsinline></video>
    <div class="hidden" id="scanner-status"></div>
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
`;

/** The camera page as the operator's ticket-to-booking rebrand renders it:
 * the rebrand rewrites the rendered catalog copy's prose only, so the
 * {tickets} holes the client fills keep their spelling. */
export const REBRANDED_PAGE = rebrandedPage(SCANNER_PAGE, [
  ["How many tickets for {name}?", "How many bookings for {name}?"],
  [
    'data-message-ticket-count-one="{count} ticket"',
    'data-message-ticket-count-one="{count} booking"',
  ],
  [
    'data-message-ticket-count-other="{count} tickets"',
    'data-message-ticket-count-other="{count} bookings"',
  ],
  ["({tickets} of {total} tickets)", "({tickets} of {total} bookings)"],
  [
    "This ticket has no door to check in at.",
    "This booking has no door to check in at.",
  ],
  [
    'data-message-not-found="Ticket not found"',
    'data-message-not-found="Booking not found"',
  ],
]);

/** One element of the installed scanner page by id — the fixture always
 * carries it, so a miss is a broken page, not an empty answer. */
export const el = (document: Window["document"], id: string): HTMLElement => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`The scanner page carries no ${id}`);
  return found as unknown as HTMLElement;
};

/** Run the bundle again against the current page, the way a second script
 * tag would: a page the template did not render whole must not half-wire
 * the scanner. */
export const evaluateBundle = (): void => runBundleOnce();

export const useScanner = (page: string = SCANNER_PAGE): ScannerHarness => {
  const window = new Window({ url: "http://localhost/" });
  const document = window.document;
  document.body.innerHTML = page;
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
export const useScannerSuite = (
  page: string = SCANNER_PAGE,
): (() => ScannerHarness) => {
  const harnesses: ScannerHarness[] = [];
  const fresh = (): ScannerHarness => {
    const h = useScanner(page);
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
  const done = h.module.admitScan(
    "/admin/groups/5/scan",
    "tok",
    "csrf",
    h.statusEl,
    h.messages,
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
      status: "checked_in",
    }),
  );
  await whenMessageShows(h, 'Does their ID match "Ada"?');
  return forced;
};

/** A forced scan of a ticket whose only rows are "No check-in": the
 * override still finds no door. */
export const forcedNoDoorScan = (h: ScannerHarness) =>
  forcedScan(h, wrongDoor());
