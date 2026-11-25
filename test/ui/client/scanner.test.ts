/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// test-groups: run-alone — the bundle runs inside happy-dom, whose internal
// task timers can outlive `happyDOM.abort()` under load; in a shared isolate a
// trailing timer fires during whichever suite runs next and fails its op
// sanitizer. Solo, it dies with the isolate — the proven-safe historical mode.

/**
 * Behavioural tests for the scanner camera bundle (`src/ui/client/scanner.ts`,
 * served as `/scanner.js`): starting the camera and reading codes. Posting
 * scans, rendering the door's answers, and the confirm dialogs live under
 * `scanner-admit`.
 */

import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  el,
  SCANNER_PAGE,
  useScanner,
  useScannerSuite,
} from "./scanner/fixture.ts";

describe("scanner bundle", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  const fresh = useScannerSuite();

  test("reacts to the camera being unavailable", async () => {
    const h = fresh();
    el(h.document, "scanner-start").click();
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

  test("a page without the camera element is a broken page, not a working scan", () => {
    const page = SCANNER_PAGE.replace(/<video[^>]*><\/video>/, "");
    expect(() => useScanner(page)).toThrow(
      "The scanner page carries no scanner-video",
    );
  });

  test("reads a token from a check-in URL, a raw token, and nothing else", () => {
    const { extractToken } = fresh().module;

    expect(extractToken("http://localhost/checkin/abc123-_")).toBe("abc123-_");
    expect(extractToken("abc123def")).toBe("abc123def");
    expect(extractToken("http://localhost/ticket/abc123def")).toBeNull();
    expect(extractToken("not a token!")).toBeNull();
  });
});
