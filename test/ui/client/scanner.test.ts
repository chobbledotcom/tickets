/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// test-groups: run-alone — the bundle runs inside happy-dom, whose internal
// task timers can outlive `happyDOM.abort()` under load; in a shared isolate a
// trailing timer fires during whichever suite runs next and fails its op
// sanitizer. Solo, it dies with the isolate — the proven-safe historical mode.

/**
 * Behavioural tests for the scanner camera bundle (`src/ui/client/scanner.js`,
 * served as `/scanner.js`): reading codes, posting scans, and rendering the
 * door's answers. The confirm dialogs and the forced-scan prompts live in
 * `scanner/answers.test.ts`.
 */

import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { createGlobalStash, requireElement } from "#test-utils/happy-dom.ts";

const MODULE_MARKER = "__scannerModule";

interface ScannerModule {
  extractToken: (data: string) => string | null;
  handleResult: (
    el: HTMLElement,
    result: Record<string, unknown>,
    messages: Record<string, string | undefined>,
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
  messages: Record<string, string | undefined>;
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
  const messages = requireElement<HTMLElement>(
    document,
    "#scanner-container",
  ).dataset;

  return {
    cleanup: async (): Promise<void> => {
      await window.happyDOM.abort();
      window.close();
    },
    confirm: {
      close: requireElement<HTMLElement>(document, "#scanner-confirm-close"),
      message: requireElement<HTMLElement>(
        document,
        "#scanner-confirm-message",
      ),
      no: requireElement<HTMLElement>(document, "#scanner-confirm-no"),
      yes: requireElement<HTMLElement>(document, "#scanner-confirm-yes"),
    },
    document,
    messages,
    module,
    restore: (): void => {
      stash.restore();
      delete (globalThis as Record<string, unknown>)[MODULE_MARKER];
    },
    statusEl: requireElement<HTMLElement>(document, "#scanner-status"),
    video: requireElement<HTMLVideoElement>(document, "#scanner-video"),
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
  const fresh = useScannerSuite();

  test("reacts to the camera being unavailable", async () => {
    const h = fresh();
    requireElement<HTMLElement>(h.document, "#scanner-start").click();
    await h.window.happyDOM.waitUntilComplete();

    expect(h.statusEl.textContent).toBe("Camera access denied");
    assertStringIncludes(h.statusEl.className, "scanner-status-error");
  });

  test("names the camera refusal from its own words when the page carries none", async () => {
    const h = fresh();
    el(h.document, "scanner-container").removeAttribute(
      "data-message-camera-denied",
    );
    el(h.document, "scanner-start").click();
    await h.window.happyDOM.waitUntilComplete();

    expect(h.statusEl.textContent).toBe("Camera access denied");
  });

  test("names the element a lookup misses, as a broken page should", () => {
    const h = fresh();
    expect(() => el(h.document, "scanner-page-does-not-carry-this")).toThrow(
      "The scanner page carries no scanner-page-does-not-carry-this",
    );
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
    assertStringIncludes(h.statusEl.className, "scanner-status-success");

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
    assertStringIncludes(h.statusEl.className, "scanner-status-warning");

    handleResult(h.statusEl, { name: "Ada", status: "refunded" }, messages);
    expect(h.statusEl.textContent).toBe("Ada has been refunded");
    assertStringIncludes(h.statusEl.className, "scanner-status-error");

    // The forced rescan of a ticket whose only rows are "No check-in"
    // answers wrong_listing again; the organiser must see why, not silence.
    handleResult(
      h.statusEl,
      { name: "Ada", status: "wrong_listing" },
      messages,
    );
    expect(h.statusEl.textContent).toBe(
      "This ticket has no door to check in at.",
    );
    assertStringIncludes(h.statusEl.className, "scanner-status-error");

    handleResult(h.statusEl, { status: "not_found" }, messages);
    expect(h.statusEl.textContent).toBe("Ticket not found");
    assertStringIncludes(h.statusEl.className, "scanner-status-error");

    handleResult(
      h.statusEl,
      { message: "Scan failed", status: "error" },
      messages,
    );
    expect(h.statusEl.textContent).toBe("Scan failed");
    assertStringIncludes(h.statusEl.className, "scanner-status-error");
  });
});
