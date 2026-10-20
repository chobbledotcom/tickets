// test-groups: run-alone — the bundle runs inside happy-dom, whose internal
// task timers can outlive `happyDOM.abort()` under load; in a shared isolate
// a trailing timer fires during whichever suite runs next and fails its op
// sanitizer. Solo, it dies with the isolate — the proven-safe historical
// mode.

/**
 * The scanner's offline mode through the built bundle: the saved ticket
 * digests, the queue, the banner, the manual switch, and the replay. The pure
 * store rules live in `scanner-door-store.test.ts`; this suite drives the
 * page wiring.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { sha256Hex } from "#crypto/sha256.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import {
  type ScannerHarness,
  useScannerSuite,
  whenTextShows,
} from "./scanner/fixture.ts";

const HASHES_KEY = "scanner:hashes:group-5";
const QUEUE_KEY = "scanner:queue:group-5";

const digestOf = (token: string): Promise<string> => sha256Hex(token);

/** The reply the door's token list endpoint gives, digests only. */
const hashesReply = async (...tokens: string[]): Promise<Response> =>
  Response.json({
    hashes: (await Promise.all(tokens.map(digestOf))).sort(),
  });

/** A queued check-in's replay answer that checks the person in. */
const checkedInReply = (): Response =>
  Response.json({
    listingName: "Doors",
    name: "Ada",
    quantity: 1,
    status: "checked_in",
    total: 1,
  });

describe("scanner offline mode", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  // The suite's storage is the fixture's own Map-backed store, cleared
  // between tests, so no per-test key cleanup is needed here.
  const fresh = useScannerSuite();

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

  /** One fresh door page, settled after its saved list loads. */
  const settledDoor = async (): Promise<ScannerHarness> => {
    const h = fresh();
    await settle();
    return h;
  };

  /** Turn the switch on and queue one saved ticket against the door's list. */
  const queueSavedTicket = async (
    h: ScannerHarness,
    token: string,
  ): Promise<void> => {
    h.offline.toggle.click();
    await dispatchScan(h, token);
  };

  /** The door's saved list, once the refresh lands the expected digest in
   * storage: the refresh saves on its own hops, so the test waits for the
   * list instead of counting hops. */
  const whenListIs = async (digest: string): Promise<string> => {
    for (let hop = 0; hop < 50; hop++) {
      await Promise.resolve();
      if (localStorage.getItem(HASHES_KEY)?.includes(digest)) break;
      await digestOf("warmup");
    }
    return localStorage.getItem(HASHES_KEY) ?? "";
  };

  test("saves the door's ticket digests on load and replaces them whole", async () => {
    {
      using _fetch = stubFetch(await hashesReply("AAAA", "BBBB"));
      fresh();
      const saved = JSON.parse(await whenListIs(await digestOf("AAAA")));
      expect(saved.hashes).toEqual(
        [await digestOf("AAAA"), await digestOf("BBBB")].sort(),
      );
      expect(typeof saved.savedAt).toBe("number");
      // The credential itself never reaches the device's storage.
      expect(localStorage.getItem(HASHES_KEY)).not.toContain("AAAA");
      expect(localStorage.getItem(HASHES_KEY)).not.toContain("BBBB");
    }
    {
      using _reload = stubFetch(await hashesReply("CCCC"));
      fresh();
      const saved = JSON.parse(await whenListIs(await digestOf("CCCC")));
      expect(saved.hashes).toEqual([await digestOf("CCCC")]);
    }
  });

  test("a saved ticket scans offline and queues its check-in once", async () => {
    using fetch = stubFetch(await hashesReply("AAAA", "BBBB"));
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
    using _fetch = stubFetch(await hashesReply("AAAA"));
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

  test("a scan with no usable saved list sends the door online to refresh", async () => {
    // A list saved 13 hours ago is past its 12 hours. The page loads from
    // the saved shell with no connection, so the refresh fails and the
    // expired list is what the door reads.
    localStorage.setItem(
      HASHES_KEY,
      JSON.stringify({
        hashes: [await digestOf("AAAA")],
        savedAt: Date.now() - 13 * 60 * 60 * 1000,
      }),
    );
    using _fetch = stubFetch(new Error("offline"));
    const h = fresh();
    await settle();
    h.offline.toggle.click();

    await dispatchScan(h, "AAAA");
    expect(h.statusEl.textContent).toBe(
      "The saved ticket list is out of date or missing. Go online and reload the page to refresh it.",
    );
    expect(h.statusEl.className).toContain("scanner-status-error");
    expect(localStorage.getItem(HASHES_KEY)).toBeNull();
    expect(h.offline.queueLine.classList.contains("hidden")).toBe(true);
  });

  test("turning the toggle off drains the queue exactly once", async () => {
    const posts: unknown[] = [];
    using fetch = stubFetch(await hashesReply("AAAA"), (_url, init) => {
      posts.push(JSON.parse(String(init?.body)));
      return checkedInReply();
    });
    const h = fresh();
    await settle();
    h.offline.toggle.click();
    await dispatchScan(h, "AAAA");
    expect(h.offline.queueLine.textContent).toBe("1 check-in waiting to send.");

    h.offline.toggle.click();
    await whenTextShows(h.statusEl, "Ada checked in for Doors (1 ticket)");
    await settle();
    // The replay names the person by the stored digest, never the token.
    expect(posts).toEqual([{ token_hash: await digestOf("AAAA") }]);
    expect(h.offline.queueLine.classList.contains("hidden")).toBe(true);
    expect(fetch.calls.length).toBe(2);
  });

  test("the sync says which queued check-in was already checked in elsewhere", async () => {
    using _fetch = stubFetch(
      await hashesReply("AAAA"),
      Response.json({
        listingName: "Doors",
        name: "Ada",
        quantity: 1,
        status: "already_checked_in",
        total: 1,
      }),
    );
    const h = await settledDoor();
    await queueSavedTicket(h, "AAAA");

    h.offline.toggle.click();
    await whenTextShows(h.statusEl, "Ada was already checked in elsewhere.");
    await settle();
    expect(h.offline.queueLine.classList.contains("hidden")).toBe(true);
  });

  test("a send that cannot land keeps its check-in queued and says so", async () => {
    using _fetch = stubFetch(await hashesReply("AAAA"), new Error("offline"));
    const h = await settledDoor();
    await queueSavedTicket(h, "AAAA");

    h.offline.toggle.click();
    await whenTextShows(
      h.statusEl,
      "Some check-ins did not send. They stay saved on this device.",
    );
    expect(h.offline.queueLine.textContent).toBe("1 check-in waiting to send.");
  });

  test("a failed online send says Network error and queues nothing", async () => {
    using _fetch = stubFetch(await hashesReply("AAAA"), new Error("offline"));
    const h = await settledDoor();
    // Offline mode is off: the door scans online, and a send that cannot
    // land says so the way the door always has.
    await dispatchScan(h, "AAAA");
    expect(h.statusEl.textContent).toBe("Network error");
    expect(h.statusEl.className).toContain("scanner-status-error");
    expect(h.offline.queueLine.classList.contains("hidden")).toBe(true);
    expect(localStorage.getItem(QUEUE_KEY)).toBeNull();
  });

  test("the manual switch persists and reloads offline", async () => {
    using _fetch = stubFetch(await hashesReply("AAAA"));
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

  test("the connection coming back sends the waiting check-ins", async () => {
    // The online event refreshes the saved list and replays the queue, so
    // the stub answers both fetches.
    using _fetch = stubFetch(
      await hashesReply("AAAA"),
      await hashesReply("AAAA"),
      checkedInReply(),
    );
    const h = await settledDoor();
    await queueSavedTicket(h, "AAAA");
    expect(h.offline.queueLine.textContent).toBe("1 check-in waiting to send.");

    h.window.dispatchEvent(new h.window.Event("online"));
    await whenTextShows(h.statusEl, "Ada checked in for Doors (1 ticket)");
    await settle();
    expect(h.offline.queueLine.classList.contains("hidden")).toBe(true);
    // The door still works offline-first while the switch is on.
    expect(h.offline.banner.classList.contains("hidden")).toBe(false);
  });
});
