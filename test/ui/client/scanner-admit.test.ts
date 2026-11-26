/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// test-groups: run-alone — the bundle runs inside happy-dom, whose internal
// task timers can outlive `happyDOM.abort()` under load; in a shared isolate a
// trailing timer fires during whichever suite runs next and fails its op
// sanitizer. Solo, it dies with the isolate — the proven-safe historical mode.

/**
 * Behavioural tests for how a scan settles with the door
 * (`src/ui/client/scanner-admit.ts`, bundled into `/scanner.js`): posting a
 * scan, and rendering each answer the door can give. The confirm dialogs and
 * the forced-scan prompts live in `scanner-admit/answers.test.ts`.
 */

import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { el, useScannerSuite } from "./scanner/fixture.ts";

describe("scanner answers", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  const fresh = useScannerSuite();

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

  test("refuses a reply that carries no scan decision", async () => {
    const { postScan } = fresh().module;
    // An expired session or a refused role answers JSON with no status.
    using _fetch = stubFetch(() => Response.json({ error: "Forbidden" }));

    await expect(postScan("/x", "tok", "csrf")).rejects.toThrow(
      "The door sent no scan decision.",
    );
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

  test("says the no-door refusal from its own words when the page carries none", () => {
    // The page always carries the attribute; this is the copy the client
    // falls back to when a broken page omits it, and it must stay the
    // page's own words.
    const h = fresh();
    el(h.document, "scanner-container").removeAttribute("data-message-no-door");

    h.module.handleResult(
      h.statusEl,
      { name: "Ada", status: "wrong_listing" },
      h.messages,
    );

    expect(h.statusEl.textContent).toBe(
      "This ticket has no door to check in at.",
    );
    assertStringIncludes(h.statusEl.className, "scanner-status-error");
  });
});
