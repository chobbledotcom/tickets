// test-groups: run-alone — the bundle runs inside happy-dom, whose internal
// task timers can outlive `happyDOM.abort()` under load; in a shared isolate a
// trailing timer fires during whichever suite runs next and fails its op
// sanitizer. Solo, it dies with the isolate — the proven-safe historical mode.

/**
 * Behavioural tests for the scanner camera bundle (`src/ui/client/scanner.js`,
 * served as `/scanner.js`).
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
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { Window } from "happy-dom";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { createGlobalStash } from "#test-utils/happy-dom.ts";

const MODULE_MARKER = "__scannerModule";

interface ScannerModule {
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

interface ScannerHarness {
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

/** The built bundle's export tail, rewritten as a global assignment: each
 * `export { internal as name }` becomes `name: internal`, an object the test
 * can reach (a function body can't carry `export`). */
const runBundleOnce = (): void => {
  const bundle = Deno.readTextFileSync("src/ui/static/scanner.js").replace(
    /export\s*\{([^}]*)\}\s*;?\s*$/,
    (_all, list: string) => {
      const pairs = list.split(",").map((one) => {
        const [internal, exported] = one.trim().split(/\s+as\s+/);
        const name = exported ?? internal ?? "";
        return `${name.trim()}:${internal?.trim() ?? ""}`;
      });
      return `;globalThis.${MODULE_MARKER}={${pairs.join(",")}};`;
    },
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
const el = (document: Window["document"], id: string): HTMLElement => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`The scanner page carries no ${id}`);
  return found as unknown as HTMLElement;
};

const useScanner = (): ScannerHarness => {
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

// happy-dom's Window starts internal async tasks/timers that no public teardown
// fully clears; confined to the emulated DOM, they would trip Deno's op
// sanitizer diagnostics in the coverage runner, so this suite runs alone.
describe("scanner bundle", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
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

  test("reacts to the camera being unavailable", async () => {
    const h = fresh();
    el(h.document, "scanner-start").click();
    await h.window.happyDOM.waitUntilComplete();

    expect(h.statusEl.textContent).toBe("Camera access denied");
    expect(h.statusEl.className).toContain("scanner-status-error");
  });

  test("reads a token from a check-in URL, a raw token, and nothing else", () => {
    const { extractToken } = fresh().module;

    expect(extractToken("http://localhost/checkin/abc123-_")).toBe("abc123-_");
    expect(extractToken("abc123def")).toBe("abc123def");
    expect(extractToken("http://localhost/ticket/abc123def")).toBeNull();
    expect(extractToken("not a token!")).toBeNull();
  });

  test("posts a scan to the door the page carries, with the organiser's choices", async () => {
    const { postScan } = fresh().module;
    using _fetch = stubFetch((url, init) => {
      expect(url).toBe("/admin/groups/5/scan");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({
        "content-type": "application/json",
        "x-csrf-token": "csrf-token",
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        force: true,
        token: "abc123def",
      });
      return Response.json({ status: "checked_in" });
    });

    const answer = await postScan(
      "/admin/groups/5/scan",
      "abc123def",
      "csrf-token",
      {
        force: true,
      },
    );
    expect(answer).toEqual({ status: "checked_in" });
  });

  test("leaves unmade choices out of the scan request", async () => {
    const { postScan } = fresh().module;
    using _fetch = stubFetch((_url, init) =>
      Response.json({
        body: JSON.parse(String(init?.body)),
        status: "ok",
      }),
    );

    const answer = await postScan("/x", "tok", "csrf");
    expect(answer).toEqual({ body: { token: "tok" }, status: "ok" });
  });

  test("fails over to the network message when the scan cannot be sent", async () => {
    const { postScan } = fresh().module;
    using _fetch = stubFetch(new Error("offline"));

    await expect(postScan("/x", "tok", "csrf")).rejects.toThrow("offline");
  });

  test("renders each answer the door can give", () => {
    const h = fresh();
    const { handleResult } = h.module;
    const { messages } = h;

    handleResult(
      h.statusEl,
      {
        listingName: ["Standard", "Society"].join(", "),
        name: "Ada",
        quantity: 2,
        status: "checked_in",
      },
      messages,
    );
    expect(h.statusEl.textContent).toBe(
      "Ada checked in for Standard, Society (2 tickets)",
    );
    expect(h.statusEl.className).toContain("scanner-status-success");

    handleResult(
      h.statusEl,
      {
        listingName: "Standard",
        name: "Ada",
        quantity: 1,
        status: "already_checked_in",
      },
      messages,
    );
    expect(h.statusEl.textContent).toBe(
      "Ada already checked in for Standard (1 ticket)",
    );
    expect(h.statusEl.className).toContain("scanner-status-warning");

    handleResult(h.statusEl, { name: "Ada", status: "refunded" }, messages);
    expect(h.statusEl.textContent).toBe("Ada has been refunded");
    expect(h.statusEl.className).toContain("scanner-status-error");

    handleResult(h.statusEl, { status: "not_found" }, messages);
    expect(h.statusEl.textContent).toBe("Ticket not found");

    handleResult(
      h.statusEl,
      { message: "Scan failed", status: "error" },
      messages,
    );
    expect(h.statusEl.textContent).toBe("Scan failed");
  });

  test("asks the organiser before an override, and takes their answer", async () => {
    const h = fresh();
    const overlay = h.confirm;

    const yes = h.module.showConfirm("Let this person in anyway?");
    expect(overlay.message.textContent).toBe("Let this person in anyway?");
    overlay.yes.click();
    expect(await yes).toBe(true);

    const no = h.module.showConfirm("Check her ID?");
    overlay.no.click();
    expect(await no).toBe(false);

    const dismissed = h.module.showConfirm("Check her ID?");
    overlay.close.click();
    expect(await dismissed).toBe(false);
  });
});
