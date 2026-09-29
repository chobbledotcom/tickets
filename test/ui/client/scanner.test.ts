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

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { el, useScannerSuite } from "./scanner/fixture.ts";

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
    expect(h.statusEl.className).toContain("scanner-status-error");
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

    // The forced rescan of a ticket whose only rows are "No check-in"
    // answers wrong_listing again; the organiser must see why, not silence.
    handleResult(
      h.statusEl,
      { name: "Ada", status: "wrong_listing" },
      messages,
    );
    expect(h.statusEl.textContent).toBe(
      "This ticket has no door to check in at",
    );
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
});
