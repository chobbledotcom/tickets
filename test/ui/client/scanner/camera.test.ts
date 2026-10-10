/// <reference lib="dom" />
// test-groups: run-alone — the bundle runs inside happy-dom (see
// scanner.test.ts for the isolate note), and this suite replaces the global
// clock, timers, and navigator while it runs.

/**
 * The camera half of the scanner bundle: starting the camera from its
 * button, the frame loop's pacing (loading guard, cooldown, one scan at a
 * time), what a decoded ticket does, and the camera's release when the page
 * hides. The confirm and answer flows live in `scanner/answers.test.ts`.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import {
  cameraFakes,
  drain,
  idle,
  scanFirst,
  scanNext,
  start,
} from "./camera-fakes.ts";
import { el, evaluateBundle, useScannerSuite } from "./fixture.ts";

describe("scanner camera", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  const fresh = useScannerSuite();

  /** A started camera whose every scan gets the same answer, with the
   * count of scans sent so far. Dispose the fetch stub with `using`. */
  const countingCamera = async (
    h: ReturnType<ReturnType<typeof useScannerSuite>>,
    fakes: ReturnType<typeof cameraFakes>,
    answer: Record<string, unknown>,
  ): Promise<{
    fetchStub: ReturnType<typeof stubFetch>;
    posts: () => number;
  }> => {
    let posts = 0;
    const fetchStub = stubFetch(() => {
      posts += 1;
      return Response.json(answer);
    });
    await start(h);
    await scanNext(fakes, "tok12345", 1000);
    return { fetchStub, posts: () => posts };
  };

  /** The checked-in answer the counting stub gives, for `quantity` tickets. */
  const checkedIn = (quantity: number): Record<string, unknown> => ({
    listingName: "Standard",
    name: "Ada",
    quantity,
    remaining: 0,
    status: "checked_in",
    total: quantity,
  });

  test("shows the scanning line and paces the loop behind the cooldown", async () => {
    const h = fresh();
    using fakes = cameraFakes(h);
    fakes.ready(4);
    await start(h);

    // The camera opened with the page's rear camera, the play started, the
    // start button gave way to the live video, and the scanning line shows.
    expect(fakes.cameraCalls).toEqual([
      [{ video: { facingMode: "environment" } }],
    ]);
    expect(h.video.srcObject).toBeTruthy();
    expect(fakes.played).toBe(1);
    expect(el(h.document, "scanner-start").className).toContain("hidden");
    expect(h.video.className).not.toContain("hidden");
    expect(h.statusEl.textContent).toBe("Scanning...");
    expect(h.statusEl.className).toContain("scanner-status");
    expect(h.statusEl.className).toContain("scanner-status-success");
    expect(h.statusEl.className).not.toContain("hidden");

    // The first frame draws but decodes nothing: the clock starts inside
    // the cooldown, so the loop only draws and reschedules at 150 ms.
    expect(fakes.drawn).toEqual([[h.video, 0, 0]]);
    expect(fakes.reads).toEqual([]);
    expect(fakes.scheduledDelay()).toBe(150);

    fakes.advance(150);
    expect(fakes.reads).toEqual([]);

    // Once the clock passes the cooldown the frame is read and decoded.
    fakes.advance(850);
    expect(fakes.reads).toEqual([[0, 0, 640, 480]]);
    expect(fakes.decodeCalls).toBe(1);
    // The loop asks the canvas for its drawing context exactly once, by the
    // name a real canvas answers.
    expect(fakes.contextTypes).toEqual(["2d"]);
    // No code in the frame: the loop keeps scanning at the same pace.
    expect(fakes.scheduledDelay()).toBe(150);
  });

  test("waits for a still-loading camera without drawing a frame", async () => {
    const h = fresh();
    using fakes = cameraFakes(h);
    fakes.ready(2);
    await start(h);

    expect(fakes.drawn).toEqual([]);
    expect(fakes.scheduledDelay()).toBe(150);

    fakes.ready(4);
    fakes.advance(150);
    expect(fakes.drawn).toEqual([[h.video, 0, 0]]);
  });

  test("admits one decoded ticket, then keeps scanning", async () => {
    const h = fresh();
    using fakes = cameraFakes(h);
    fakes.ready(4);
    fakes.decode({ data: "tok12345" });
    const bodies: Record<string, unknown>[] = [];
    const headers: unknown[] = [];
    using _fetch = stubFetch((_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      headers.push(init?.headers);
      return Response.json({
        listingName: "Standard",
        name: "Ada",
        quantity: 2,
        remaining: 0,
        status: "checked_in",
        total: 2,
      });
    });

    await start(h);
    await scanFirst(fakes, "tok12345");

    // The decoded ticket posted once, carrying the page's own token, and
    // the answer showed with the tickets the scan really took.
    expect(bodies).toEqual([{ token: "tok12345" }]);
    expect(headers[0]).toEqual({
      "content-type": "application/json",
      "x-csrf-token": "csrf-page-token",
    });
    expect(h.statusEl.textContent).toBe(
      "Ada checked in for Standard (2 tickets)",
    );

    // The settled scan's own line fades only after its full delay: the
    // scanning line's earlier fade was cancelled, so nothing fades at 6000.
    fakes.advance(3_999);
    expect(h.statusEl.className).not.toContain("scanner-status-fade-out");
    fakes.advance(1);
    expect(h.statusEl.className).not.toContain("scanner-status-fade-out");
    fakes.advance(1_000);
    expect(h.statusEl.className).toContain("scanner-status-fade-out");

    // A fresh ticket on a later frame admits too: the scan settled, so the
    // loop went back to work.
    await scanNext(fakes, "other9876", 2_150);
    expect(bodies).toEqual([{ token: "tok12345" }, { token: "other9876" }]);
    expect(fakes.scheduledDelay()).toBe(150);
  });

  test("never admits a second ticket while one scan is still running", async () => {
    const h = fresh();
    using fakes = cameraFakes(h);
    fakes.ready(4);
    let first = true;
    using _fetch = stubFetch(() => {
      // The first answer is held back, so the next frame decodes while the
      // first scan is still in flight.
      if (first) {
        first = false;
        const { promise } = Promise.withResolvers<Response>();
        return promise;
      }
      return Response.json({ status: "not_found" });
    });

    await start(h);
    fakes.decode({ data: "tok12345" });
    fakes.advance(1000);
    fakes.decode({ data: "other9876" });
    await idle(fakes, 2_150);

    // The second frame stayed a preview only: the scan in flight kept the
    // loop from admitting anyone else, even after the cooldown passed, so
    // the status is unchanged.
    expect(h.statusEl.textContent).toBe("Scanning...");

    // The waiting status still fades on its own while the scan waits.
    await idle(fakes, 4_850);
    expect(h.statusEl.className).toContain("scanner-status-fade-out");
  });

  test("says so when a code carries no ticket token", async () => {
    const h = fresh();
    using fakes = cameraFakes(h);
    fakes.ready(4);
    fakes.decode({ data: "not-a-token!" });
    const bodies: unknown[] = [];
    using _fetch = stubFetch((_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ status: "not_found" });
    });

    await start(h);
    await scanFirst(fakes, "not-a-token!");

    expect(h.statusEl.textContent).toBe("Invalid QR code");
    expect(h.statusEl.className).toContain("scanner-status-error");
    expect(bodies).toEqual([]);
    // The unreadable code spent its cooldown, and the loop moved on.
    await idle(fakes, 2000);
    expect(fakes.reads.length).toBeGreaterThan(1);
  });

  test("paces every later scan behind the last frame's cooldown", async () => {
    const h = fresh();
    using fakes = cameraFakes(h);
    fakes.ready(4);
    const started = await countingCamera(h, fakes, checkedIn(1));
    using _fetch = started.fetchStub;

    // A first ticket at 2000...
    expect(started.posts()).toBe(1);

    // ...an unreadable code at 4000...
    await scanNext(fakes, "not-a-token!", 2000);
    expect(h.statusEl.textContent).toBe("Invalid QR code");

    // ...and a second ticket at 6000: each scan's cooldown counts from its
    // own frame, not from an accumulated total.
    await scanNext(fakes, "other9876", 2000);
    expect(started.posts()).toBe(2);
    await idle(fakes, 2000);
    expect(fakes.reads.length).toBeGreaterThan(2);

    // A third ticket at 10000 admits on its own cooldown...
    await scanNext(fakes, "third0000", 2000);
    expect(started.posts()).toBe(3);

    // ...and its window holds: the resend while it is open stays a
    // duplicate.
    await idle(fakes, 1_500);
    await scanNext(fakes, "third0000", 150);
    expect(started.posts()).toBe(3);
  });

  test("deduplicates a ticket until its window closes", async () => {
    const h = fresh();
    using fakes = cameraFakes(h);
    fakes.ready(4);
    const started = await countingCamera(h, fakes, { status: "not_found" });
    using _fetch = started.fetchStub;

    // The first ticket posts at 2000...
    expect(started.posts()).toBe(1);

    // ...and the same ticket inside its own window stays a duplicate...
    await scanNext(fakes, "tok12345", 2000);
    expect(started.posts()).toBe(1);

    // ...a second ticket posts at 6000 and takes over the window...
    await scanNext(fakes, "other9876", 2000);
    expect(started.posts()).toBe(2);

    // ...and the first ticket's window must not wipe the second one: the
    // duplicate stays a duplicate until the second ticket's own window
    // closes.
    await idle(fakes, 4850);
    expect(started.posts()).toBe(2);
    await idle(fakes, 150);
    expect(started.posts()).toBe(3);

    // The refreshed window holds again for the ticket it now covers.
    await idle(fakes, 150);
    expect(started.posts()).toBe(3);
  });

  test("fails over to the network message when the scan cannot be sent", async () => {
    const h = fresh();
    using fakes = cameraFakes(h);
    fakes.ready(4);
    fakes.decode({ data: "tok12345" });
    using _fetch = stubFetch(new Error("offline"));

    await start(h);
    await scanFirst(fakes, "tok12345");

    expect(h.statusEl.textContent).toBe("Network error");
    expect(h.statusEl.className).toContain("scanner-status-error");
    // The failed scan settled too, and its cooldown spent, so the loop went
    // back to reading frames.
    await idle(fakes, 2_000);
    expect(fakes.reads.length).toBeGreaterThan(1);
  });

  test("cancels the previous status's fade when a later status replaces it", async () => {
    const h = fresh();
    using fakes = cameraFakes(h);
    fakes.ready(4);
    const started = await countingCamera(h, fakes, checkedIn(2));
    using _fetch = started.fetchStub;

    // A third status arrives while the second one's fade is still armed:
    // the second status's fade must never fire after the replacement.
    await scanNext(fakes, "other9876", 2_150);

    // A fourth status arrives on a tick the same clock step reaches as the
    // third fade it replaces: that fade must not fire either.
    await scanNext(fakes, "fourth000", 5_150);
    expect(h.statusEl.className).not.toContain("scanner-status-fade-out");
  });

  test("releases the camera tracks when the page hides", async () => {
    const h = fresh();
    using fakes = cameraFakes(h);
    fakes.ready(4);

    el(h.document, "scanner-start").click();
    await drain();

    h.document.dispatchEvent(new h.window.Event("pagehide"));
    expect(fakes.tracks.map((track) => track.stopped)).toEqual([true, true]);
  });

  test("stays silent on a page the template did not render whole", () => {
    // Re-running the bundle on a page missing an element must not wire half
    // a scanner: init bows out when any of its elements is missing.
    for (const id of ["scanner-video", "scanner-start"]) {
      const h = fresh();
      el(h.document, id).remove();
      expect(() => evaluateBundle()).not.toThrow();
    }
  });
});
