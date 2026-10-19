// test-groups: run-alone — the bundle runs inside happy-dom, whose internal
// task timers can outlive `happyDOM.abort()` under load; in a shared isolate
// a trailing timer fires during whichever suite runs next and fails its op
// sanitizer. Solo, it dies with the isolate — the proven-safe historical
// mode.

/**
 * The scanner's offline mode through the built bundle: the saved ticket
 * list, the queue, the banner, the manual switch, and the replay. The pure
 * store rules live in `scanner-offline.test.ts`; this suite drives the page
 * wiring.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import {
  type ScannerHarness,
  useScannerSuite,
  whenTextShows,
} from "./scanner/fixture.ts";

const TOKENS_KEY = "scanner:tokens:group-5";
const QUEUE_KEY = "scanner:queue:group-5";
const MODE_KEY = "scanner:offline:group-5";

describe("scanner offline mode", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  const fresh = useScannerSuite();

  afterEach(() => {
    for (const key of [TOKENS_KEY, QUEUE_KEY, MODE_KEY]) {
      localStorage.removeItem(key);
    }
  });

  /** Drain the promise hops the stubbed fetch and its render chain need —
   * the same bound-drain idiom `whenTextShows` uses, with no clock. */
  const settle = async (): Promise<void> => {
    for (let hops = 0; hops < 100; hops++) {
      await Promise.resolve();
    }
  };

  const dispatchScan = (h: ScannerHarness, token: string): Promise<void> =>
    h.module.dispatchScan(
      h.module.offline!,
      "/admin/groups/5/scan",
      token,
      "csrf",
      h.statusEl,
      h.messages,
    );

  test("saves the door's tokens on load and replaces them whole", async () => {
    {
      using _fetch = stubFetch(Response.json({ tokens: ["AAAA", "BBBB"] }));
      fresh();
      await settle();
      expect(JSON.parse(localStorage.getItem(TOKENS_KEY)!)).toEqual([
        "AAAA",
        "BBBB",
      ]);
    }
    {
      using _reload = stubFetch(Response.json({ tokens: ["CCCC"] }));
      fresh();
      await settle();
      expect(JSON.parse(localStorage.getItem(TOKENS_KEY)!)).toEqual(["CCCC"]);
    }
  });

  test("a saved ticket scans offline and queues its check-in once", async () => {
    using fetch = stubFetch(Response.json({ tokens: ["AAAA", "BBBB"] }));
    const h = fresh();
    await settle();
    h.offline.toggle.click();
    expect(h.offline.banner.classList.contains("hidden")).toBe(false);
    expect(h.offline.toggle.textContent).toBe("Offline mode: on");

    await dispatchScan(h, "AAAA");
    expect(h.statusEl.textContent).toBe(
      "Saved ticket. The check-in will send when the connection is back.",
    );
    expect(h.statusEl.className).toContain("scanner-status-warning");
    expect(h.offline.queueLine.textContent).toBe("1 check-in waiting to send.");

    await dispatchScan(h, "AAAA");
    expect(h.offline.queueLine.textContent).toBe("1 check-in waiting to send.");
    expect(fetch.calls.length).toBe(1);
  });

  test("an unknown ticket is refused offline", async () => {
    using _fetch = stubFetch(Response.json({ tokens: ["AAAA"] }));
    const h = fresh();
    await settle();
    h.offline.toggle.click();

    await dispatchScan(h, "ZZZZ");
    expect(h.statusEl.textContent).toBe(
      "This ticket is not in the saved list. Go online to check it.",
    );
    expect(h.statusEl.className).toContain("scanner-status-error");
    expect(h.offline.queueLine.classList.contains("hidden")).toBe(true);
  });

  test("turning the toggle off drains the queue exactly once", async () => {
    using fetch = stubFetch(
      Response.json({ tokens: ["AAAA"] }),
      Response.json({
        listingName: "Doors",
        name: "Ada",
        quantity: 1,
        status: "checked_in",
        total: 1,
      }),
    );
    const h = fresh();
    await settle();
    h.offline.toggle.click();
    await dispatchScan(h, "AAAA");
    expect(h.offline.queueLine.textContent).toBe("1 check-in waiting to send.");

    h.offline.toggle.click();
    await whenTextShows(h.statusEl, "Ada checked in for Doors (1 ticket)");
    await settle();
    expect(h.offline.queueLine.classList.contains("hidden")).toBe(true);
    expect(fetch.calls.length).toBe(2);
  });

  test("a send that cannot land keeps its check-in queued and says so", async () => {
    using _fetch = stubFetch(
      Response.json({ tokens: ["AAAA"] }),
      new Error("offline"),
    );
    const h = fresh();
    await settle();
    h.offline.toggle.click();
    await dispatchScan(h, "AAAA");

    h.offline.toggle.click();
    await whenTextShows(
      h.statusEl,
      "Some check-ins did not send. They stay saved on this device.",
    );
    expect(h.offline.queueLine.textContent).toBe("1 check-in waiting to send.");
  });

  test("a failed send falls back to the saved list, and its retry delivers", async () => {
    using fetch = stubFetch(
      Response.json({ tokens: ["AAAA"] }),
      new Error("offline"),
      Response.json({
        listingName: "Doors",
        name: "Ada",
        quantity: 1,
        status: "checked_in",
        total: 1,
      }),
    );
    const h = fresh();
    await settle();
    // Online by default: the send fails, the door falls back to the list.
    await dispatchScan(h, "AAAA");
    expect(h.offline.banner.classList.contains("hidden")).toBe(false);
    expect(h.statusEl.textContent).toBe(
      "Saved ticket. The check-in will send when the connection is back.",
    );
    expect(h.offline.queueLine.textContent).toBe("1 check-in waiting to send.");

    // The retry lands: the token leaves the queue and the banner clears.
    await dispatchScan(h, "AAAA");
    await whenTextShows(h.statusEl, "Ada checked in for Doors (1 ticket)");
    await settle();
    expect(h.offline.queueLine.classList.contains("hidden")).toBe(true);
    expect(h.offline.banner.classList.contains("hidden")).toBe(true);
    expect(fetch.calls.length).toBe(3);
  });

  test("the manual switch persists and reloads offline", async () => {
    using _fetch = stubFetch(Response.json({ tokens: ["AAAA"] }));
    const first = fresh();
    await settle();
    first.offline.toggle.click();
    expect(first.offline.toggle.textContent).toBe("Offline mode: on");
    expect(first.offline.toggle.getAttribute("aria-pressed")).toBe("true");

    const second = fresh();
    await settle();
    expect(second.offline.toggle.textContent).toBe("Offline mode: on");
    expect(second.offline.banner.classList.contains("hidden")).toBe(false);

    second.offline.toggle.click();
    expect(second.offline.toggle.textContent).toBe("Offline mode: off");
    expect(second.offline.banner.classList.contains("hidden")).toBe(true);
  });

  test("the banner clears when the connection returns", async () => {
    using _fetch = stubFetch(
      Response.json({ tokens: ["AAAA"] }),
      new Error("offline"),
    );
    const h = fresh();
    await settle();
    await dispatchScan(h, "AAAA");
    expect(h.offline.banner.classList.contains("hidden")).toBe(false);

    h.window.dispatchEvent(new h.window.Event("online"));
    await settle();
    expect(h.offline.banner.classList.contains("hidden")).toBe(true);
  });
});
