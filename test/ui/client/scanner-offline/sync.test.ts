// test-groups: run-alone — the bundle runs inside happy-dom, whose internal
// task timers can outlive `happyDOM.abort()` under load; in a shared isolate
// a trailing timer fires during whichever suite runs next and fails its op
// sanitizer. Solo, it dies with the isolate — the proven-safe historical
// mode.

/**
 * The sync's per-check-in story through the built bundle: every queued
 * check-in's replay answers on the page by name, so a check-in another
 * door already took is never mistaken for a fresh one. The queue's send
 * rules live in `scanner-offline.test.ts`.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  useScannerSuite,
  whenTextShows,
} from "#test/ui/client/scanner/fixture.ts";
import {
  dispatchScan,
  duplicateReply,
  hashesReply,
  queueSavedTicket,
  queueTwoSaved,
  recordedCheckIn,
  settle,
  settledDoor,
  syncAndWait,
} from "#test/ui/client/scanner/offline-fixture.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

describe("the scanner's sync", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  const fresh = useScannerSuite();

  test("the sync says which queued check-in was already checked in elsewhere", async () => {
    using _fetch = stubFetch(await hashesReply("AAAA"), duplicateReply("Ada"));
    const h = await settledDoor(fresh);
    await queueSavedTicket(h, "AAAA");

    await syncAndWait(h, "Ada");
    // The page keeps the sync's answer where the door can read it: the
    // waiting line names the check-in the door had already taken, and the
    // status line says the same in the sync's own words.
    expect(h.statusEl.textContent).toBe(
      "Ada was already checked in elsewhere.",
    );
    expect(h.offline.queueLine.classList.contains("hidden")).toBe(false);
    expect(h.offline.queueLine.textContent).toBe(
      "1 person was already checked in elsewhere: Ada.",
    );
  });

  test("the sync names every queued check-in taken elsewhere, not just the last", async () => {
    using _fetch = stubFetch(
      await hashesReply("AAAA", "BBBB"),
      duplicateReply("Ada"),
      duplicateReply("Grace"),
    );
    const h = await settledDoor(fresh);
    await queueTwoSaved(h);
    expect(h.offline.queueLine.textContent).toBe(
      "2 check-ins waiting to send.",
    );

    await syncAndWait(h, "Grace");
    // Both duplicates stay named on the page: the status line holds the
    // last answer, and the waiting line holds every name, so a camera
    // message cannot take either story away.
    expect(h.offline.queueLine.classList.contains("hidden")).toBe(false);
    expect(h.offline.queueLine.textContent).toBe(
      "2 people were already checked in elsewhere: Ada, Grace.",
    );
    // The names survive the repaints a later page event runs.
    h.offline.toggle.click();
    expect(h.offline.queueLine.textContent).toBe(
      "2 people were already checked in elsewhere: Ada, Grace.",
    );
  });

  test("a sync that sends some and loses some names both facts", async () => {
    using _fetch = stubFetch(
      await hashesReply("AAAA", "BBBB"),
      duplicateReply("Ada"),
      new Error("offline"),
    );
    const h = await settledDoor(fresh);
    await queueTwoSaved(h);
    await syncAndWait(h, "Ada");
    // The first check-in was a duplicate; the second never reached the
    // server. The line says both, so neither fact is lost.
    expect(h.offline.queueLine.textContent).toBe(
      "1 check-in waiting to send. 1 person was already checked in elsewhere: Ada.",
    );
  });

  test("the next sync replaces the duplicate story whole", async () => {
    const posts: unknown[] = [];
    using fetch = stubFetch(
      await hashesReply("AAAA", "BBBB"),
      duplicateReply("Ada"),
      recordedCheckIn(posts),
      recordedCheckIn(posts),
    );
    const h = await settledDoor(fresh);
    await queueTwoSaved(h);

    // First sync: the door had already taken AAAA elsewhere; BBBB sends.
    await syncAndWait(h, "Ada");
    expect(h.offline.queueLine.textContent).toBe(
      "1 person was already checked in elsewhere: Ada.",
    );

    // A later scan queues AAAA again, and the next sync delivers it. The
    // old duplicate story goes with the sync that told it.
    h.offline.toggle.click();
    await dispatchScan(h, "AAAA");
    expect(h.offline.queueLine.textContent).toBe(
      "1 check-in waiting to send. 1 person was already checked in elsewhere: Ada.",
    );
    h.offline.toggle.click();
    await whenTextShows(h.statusEl, "Ada checked in for Doors (1 ticket)");
    await settle();
    expect(fetch.calls.length).toBe(4);
    expect(h.offline.queueLine.classList.contains("hidden")).toBe(true);
  });
});
