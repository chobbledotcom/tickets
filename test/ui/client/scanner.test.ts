/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// test-groups: run-alone — the bundle runs inside happy-dom, whose internal
// task timers can outlive `happyDOM.abort()` under load; in a shared isolate a
// trailing timer fires during whichever suite runs next and fails its op
// sanitizer. Solo, it dies with the isolate — the proven-safe historical mode.

/**
 * Behavioural tests for the scanner camera bundle (`src/ui/client/scanner.ts`,
 * served as `/scanner.js`): reading codes, posting scans, and rendering the
 * door's answers. The confirm dialogs and the forced-scan prompts live in
 * `scanner/answers.test.ts`.
 */

import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stubFetch } from "#test-utils/fetch-stub.ts";
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

    expect(h.statusEl.textContent).toBe(
      "The camera is blocked. Allow camera access for this site, then try again.",
    );
    assertStringIncludes(h.statusEl.className, "scanner-status-error");
  });

  test("names the element a lookup misses, as a broken page should", () => {
    const h = fresh();
    expect(() => el(h.document, "scanner-page-does-not-carry-this")).toThrow(
      "The scanner page carries no scanner-page-does-not-carry-this",
    );
  });

  test("a page without the camera element is a broken page, not a working scan", () => {
    const page = SCANNER_PAGE.replace(/<video[^>]*><\/video>/, "");
    expect(() => useScanner(page)).toThrow("Missing element: #scanner-video");
  });

  test("reads a token from a check-in URL, a raw token, and nothing else", () => {
    const { extractToken } = fresh().module;

    expect(extractToken("http://localhost/checkin/abc123-_")).toBe("abc123-_");
    expect(extractToken("abc123def")).toBe("abc123def");
    expect(extractToken("http://localhost/ticket/abc123def")).toBeNull();
    expect(extractToken("not a token!")).toBeNull();
  });

  test("posts a scan to the door the page carries, with the page's token", async () => {
    const h = fresh();
    using _fetch = stubFetch((url, init) => {
      expect(url).toBe("/admin/groups/5/scan");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({
        "content-type": "application/json",
        "x-csrf-token": "csrf-token",
      });
      expect(JSON.parse(String(init?.body))).toEqual({ token: "abc123def" });
      return Response.json({ status: "not_found" });
    });

    const settled = await h.module.admitScan(
      "/admin/groups/5/scan",
      "abc123def",
      "csrf-token",
      h.say,
      h.wording,
    );
    expect(settled).toEqual({
      answer: { status: "not_found" },
      declined: false,
    });
  });

  test("fails loudly on an answer that is not JSON", async () => {
    const h = fresh();
    using _fetch = stubFetch(new Response("<html>Log in</html>"));

    // The built bundle renames the error class, so its message names it.
    await expect(
      h.module.admitScan("/x", "tok", "csrf", h.say, h.wording),
    ).rejects.toThrow("The request to /x answered 200 without JSON");
  });

  test("renders each answer the door can give", () => {
    const h = fresh();
    const show = (answer: Record<string, unknown>) =>
      h.module.sayAnswer(answer, h.wording, h.say);

    show({
      listingName: ["Standard", "Society"].join(", "),
      name: "Ada",
      quantity: 2,
      remaining: 0,
      status: "checked_in",
      total: 2,
    });
    expect(h.statusEl.textContent).toBe(
      "Ada checked in for Standard, Society (2 tickets)",
    );
    assertStringIncludes(h.statusEl.className, "scanner-status-success");

    show({
      listingName: "Standard",
      name: "Ada",
      quantity: 1,
      status: "already_checked_in",
      total: 1,
    });
    expect(h.statusEl.textContent).toBe(
      "Ada already checked in for Standard (1 ticket)",
    );
    assertStringIncludes(h.statusEl.className, "scanner-status-warning");

    show({ name: "Ada", status: "refunded" });
    expect(h.statusEl.textContent).toBe("Ada has been refunded");
    assertStringIncludes(h.statusEl.className, "scanner-status-error");

    // The forced rescan of a ticket whose only rows are "No check-in"
    // answers wrong_listing again; the organiser must see why, not silence.
    show({ listingName: "Standard", name: "Ada", status: "wrong_listing" });
    expect(h.statusEl.textContent).toBe(
      "This ticket has no door to check in at.",
    );
    assertStringIncludes(h.statusEl.className, "scanner-status-error");

    show({ status: "not_found" });
    expect(h.statusEl.textContent).toBe(
      "This ticket was not found. Check that it is for this event.",
    );
    assertStringIncludes(h.statusEl.className, "scanner-status-error");

    // A refusal shows the API's own words, and a body with none shows the
    // page's error words.
    show({ error: "Invalid quantity", status: "other" });
    expect(h.statusEl.textContent).toBe("Invalid quantity");
    show({ status: "other" });
    expect(h.statusEl.textContent).toBe(
      "The check-in did not work. Try again.",
    );
    assertStringIncludes(h.statusEl.className, "scanner-status-error");
  });
});
