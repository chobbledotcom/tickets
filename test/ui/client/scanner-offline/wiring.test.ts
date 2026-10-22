/**
 * The offline page's wiring, driven from the module's own exports: one door
 * page over fake elements, the saved list it loads, the switch it carries,
 * and the queue line it paints. The replay's rules live in `rules.test.ts`;
 * the built-bundle journeys live in `../scanner-offline.test.ts` and
 * `sync.test.ts`.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import {
  interpolate,
  type ScanAnswer,
  type ScanMessages,
  setupOfflineScanner,
} from "#src/ui/client/scanner-offline.ts";
import {
  digestOf,
  HASHES_KEY,
  hashesReply,
  readQueue,
  settle,
} from "#test/ui/client/scanner/offline-fixture.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { createGlobalStash } from "#test-utils/happy-dom.ts";
import {
  checkedIn,
  fakePage,
  PAGE_WORDS,
  SCAN_PATH,
  showStatus,
  TOKENS_PATH,
  takenElsewhere,
} from "./page-fakes.ts";

describe("the offline page's wiring", () => {
  let active: { restore: () => void } | null = null;
  afterEach(() => {
    active?.restore();
    active = null;
  });

  /** Wire one page onto the globals and hand the test the page's fakes,
   * the admissions the page's live flow received, and what each replay
   * send carried. */
  const wire = (answers: ScanAnswer[] = [], parts = fakePage()) => {
    active?.restore();
    const admissions: { messages: ScanMessages; tokenHash: string }[] = [];
    const posts: { choices: Record<string, unknown>; token: string }[] = [];
    const pending = [...answers];
    const stash = createGlobalStash();
    stash.set("document", parts.document);
    stash.set("window", parts.window);
    stash.set("localStorage", parts.storage);
    const offline = setupOfflineScanner({
      admitOne: async (tokenHash, post, messages): Promise<ScanAnswer> => {
        admissions.push({ messages, tokenHash });
        return post(SCAN_PATH, tokenHash, "csrf");
      },
      container: parts.container as unknown as HTMLElement,
      doorCacheKey: parts.container.dataset.doorCacheKey ?? "",
      post: (_scanPath, token, _csrfToken, choices): Promise<ScanAnswer> => {
        posts.push({ choices: choices ?? {}, token });
        const answer = pending.shift();
        if (answer === undefined) throw new Error("the test staged no answer");
        return Promise.resolve(answer);
      },
      showStatus,
      statusEl: parts.status as unknown as HTMLElement,
      tokensPath: TOKENS_PATH,
    });
    return { ...parts, admissions, offline, posts, stash };
  };

  /** One wired door whose saved list loaded, with the switch on and the
   * given tickets scanned against it. */
  const doorWithSaved = async (
    answers: ScanAnswer[],
    listTokens: string[],
    scanTokens: string[],
  ): Promise<ReturnType<typeof wire>> => {
    using _fetch = stubFetch(await hashesReply(...listTokens));
    const h = wire(answers);
    await settle();
    h.toggle.click();
    for (const token of scanTokens) await h.offline.scan(token);
    return h;
  };

  test("the page loads its digest list fresh and waits quiet", async () => {
    using _fetch = stubFetch(await hashesReply("AAAA", "BBBB"));
    const h = wire();
    await settle();

    const saved = JSON.parse(h.backing.get(HASHES_KEY) ?? "");
    expect(saved.hashes).toEqual(
      [await digestOf("AAAA"), await digestOf("BBBB")].sort(),
    );
    expect(h.banner.classList.contains("hidden")).toBe(true);
    expect(h.toggle.textContent).toBe("Offline mode: off");
    expect(h.toggle.getAttribute("aria-pressed")).toBe("false");
    expect(h.queueLine.textContent).toBe("");
    expect(h.queueLine.classList.contains("hidden")).toBe(true);
    expect(h.offline.routeScan()).toBe("online");
  });

  test("a refresh that cannot land leaves the door without a list", async () => {
    using _fetch = stubFetch(new Error("offline"));
    const h = wire();
    await settle();

    await h.offline.scan("AAAA");
    expect(h.status.textContent).toBe(
      "The saved ticket list is out of date or missing. Go online and reload the page to refresh it.",
    );
    expect(h.status.className).toBe("scanner-status-error");
    expect(readQueue()).toEqual([]);
  });

  test("a tokens reply that is no list keeps the door without one", async () => {
    using _fetch = stubFetch(Response.json({ hashes: 42 }));
    const h = wire();
    await settle();

    await h.offline.scan("AAAA");
    expect(h.status.textContent).toBe(
      "The saved ticket list is out of date or missing. Go online and reload the page to refresh it.",
    );
  });

  test("a reply keeps only the entries that name tickets", async () => {
    using _fetch = stubFetch(
      Response.json({ hashes: [await digestOf("AAAA"), 7, null] }),
    );
    const h = wire();
    await settle();

    await h.offline.scan("AAAA");
    expect(h.status.textContent).toBe(
      "Saved ticket. The check-in will send when the connection is back.",
    );
    expect(readQueue().map((delivery) => delivery.tokenHash)).toEqual([
      await digestOf("AAAA"),
    ]);

    await h.offline.scan("BBBB");
    expect(h.status.textContent).toBe(
      "This ticket is not in the saved list. Go online to check it.",
    );
  });

  test("the manual switch turns the offline door on and keeps it on", async () => {
    using _fetch = stubFetch(await hashesReply("AAAA"));
    const h = wire();
    await settle();

    h.toggle.click();
    expect(h.banner.classList.contains("hidden")).toBe(false);
    expect(h.toggle.textContent).toBe("Offline mode: on");
    expect(h.toggle.getAttribute("aria-pressed")).toBe("true");
    expect(h.offline.routeScan()).toBe("offline");

    // A reload reads the switch the door left it: the mode lives in the
    // door's storage, not in the page.
    const again = fakePage();
    again.backing = h.backing;
    again.storage = h.storage;
    const reloaded = wire([], again);
    await settle();
    expect(reloaded.offline.routeScan()).toBe("offline");
    expect(reloaded.banner.classList.contains("hidden")).toBe(false);
    expect(reloaded.toggle.textContent).toBe("Offline mode: on");
  });

  test("a saved ticket waits in the door's queue until the sync", async () => {
    const h = await doorWithSaved([], ["AAAA", "BBBB"], ["AAAA"]);

    expect(h.status.textContent).toBe(
      "Saved ticket. The check-in will send when the connection is back.",
    );
    expect(h.status.className).toBe("scanner-status-warning");
    expect(h.queueLine.textContent).toBe("1 check-in waiting to send.");
    expect(readQueue()).toEqual([
      {
        operationId: expect.any(String),
        queuedAt: expect.any(Number),
        tokenHash: await digestOf("AAAA"),
      },
    ]);

    await h.offline.scan("AAAA");
    expect(h.status.textContent).toBe(
      "Saved ticket. The check-in will send when the connection is back.",
    );
    expect(h.status.className).toBe("scanner-status-warning");
    // The same ticket scanned again queues its own delivery: a party's
    // next arrival is another check-in, and the server answers one
    // delivery once.
    expect(readQueue()).toHaveLength(2);
  });

  test("two saved tickets waiting say the count", async () => {
    const h = await doorWithSaved([], ["AAAA", "BBBB"], ["AAAA", "BBBB"]);
    expect(h.queueLine.textContent).toBe("2 check-ins waiting to send.");
  });

  test("the switch turning off sends what waited, by digest", async () => {
    const h = await doorWithSaved([checkedIn()], ["AAAA"], ["AAAA"]);
    const delivery = readQueue()[0];

    h.toggle.click();
    await settle();
    expect(h.queueLine.textContent).toBe("");
    expect(h.queueLine.classList.contains("hidden")).toBe(true);
    expect(h.admissions).toHaveLength(1);
    // The replay names the person by the digest the device stored, never
    // the token, and claims its own delivery.
    expect(h.admissions[0]?.tokenHash).toBe(await digestOf("AAAA"));
    expect(h.posts[0]?.token).toBe(await digestOf("AAAA"));
    expect(h.posts[0]?.choices.operationId).toBe(delivery?.operationId);
    // The sync's own wording rides with the admission.
    expect(h.admissions[0]?.messages.messageAlreadyCheckedIn).toBe(
      "{name} was already checked in elsewhere.",
    );
  });

  test("a sync names every person another door already took", async () => {
    const h = await doorWithSaved(
      [takenElsewhere("Ada"), takenElsewhere("Bo"), checkedIn()],
      ["AAAA", "BBBB"],
      ["AAAA", "BBBB"],
    );

    h.toggle.click();
    await settle();
    expect(h.queueLine.textContent).toBe(
      "2 people were already checked in elsewhere: Ada, Bo.",
    );

    // The next sync replaces the story whole: nobody new was taken, so
    // the line carries no stale names.
    h.toggle.click();
    h.toggle.click();
    await settle();
    expect(h.queueLine.textContent).toBe("");
    expect(h.queueLine.classList.contains("hidden")).toBe(true);
  });

  test("a replay that cannot settle keeps its check-in and says so", async () => {
    // The staged body is no scan answer: the strict wrapper refuses it, so
    // the check-in did not land and must stay queued.
    const h = await doorWithSaved(
      [{ status: "wat" } as unknown as ScanAnswer],
      ["AAAA"],
      ["AAAA"],
    );

    h.toggle.click();
    await settle();
    expect(h.status.textContent).toBe(
      "Some check-ins did not send. They stay saved on this device.",
    );
    expect(h.status.className).toBe("scanner-status-error");
    expect(readQueue()).toHaveLength(1);
  });

  test("the connection coming back sends what waited once", async () => {
    const load = stubFetch(await hashesReply("AAAA"));
    const h = wire([checkedIn()]);
    try {
      await settle();
      h.toggle.click();
      await h.offline.scan("AAAA");
      expect(readQueue()).toHaveLength(1);
    } finally {
      load.restore();
    }

    using _reconnect = stubFetch(await hashesReply("AAAA", "BBBB"));
    h.goOnline(h.onlineRuns);
    await settle();
    expect(readQueue()).toEqual([]);
    // The refresh and the event both offered a replay, and the gate stood
    // the second one down, so the check-in sent once.
    expect(h.admissions).toHaveLength(1);
  });

  test("storage that cannot hold state still serves the door for the visit", async () => {
    using _fetch = stubFetch(await hashesReply("AAAA"));
    const parts = fakePage();
    parts.storage = {
      ...parts.storage,
      setItem: () => {
        throw new Error("the device blocked storage");
      },
    };
    const h = wire([checkedIn()], parts);
    await settle();
    h.toggle.click();
    await h.offline.scan("AAAA");
    expect(h.status.textContent).toBe(
      "Saved ticket. The check-in will send when the connection is back.",
    );
    expect(h.queueLine.textContent).toBe("1 check-in waiting to send.");

    // The visit's own memory holds the queue: back in online mode, the
    // sync still sends what the visit saved and drops it from memory.
    h.toggle.click();
    await settle();
    expect(h.queueLine.textContent).toBe("");
    expect(h.status.textContent).toBe(
      "Saved ticket. The check-in will send when the connection is back.",
    );

    // A fresh page gets none of it: the visit's memory died with the
    // visit, and the device holds no digests.
    const again = wire([], fakePage());
    await settle();
    expect(again.offline.routeScan()).toBe("online");
    expect(readQueue()).toEqual([]);
  });

  test("an older cached page still takes check-ins without the offline pieces", async () => {
    using _fetch = stubFetch(await hashesReply("AAAA"));
    const h = wire(
      [],
      fakePage({ missing: ["banner", "queue", "toggle"], words: {} }),
    );
    await settle();

    await h.offline.scan("AAAA");
    // The page says nothing it has no word for: an absent attribute is
    // absent, not an empty word.
    expect(h.status.textContent).toBe("");
  });

  test("an older page without the sync wording keeps the door's usual words", async () => {
    using _fetch = stubFetch(await hashesReply("AAAA"));
    const words = { ...PAGE_WORDS };
    delete words.messageOfflineSyncAlreadyCheckedIn;
    const h = wire([takenElsewhere("Ada")], fakePage({ words }));
    await settle();
    h.toggle.click();
    await h.offline.scan("AAAA");

    h.toggle.click();
    await settle();
    expect(h.admissions[0]?.messages.messageAlreadyCheckedIn).toBe(
      "{name} already checked in for {listingName} ({tickets})",
    );
    expect(h.queueLine.textContent).toBe(
      "1 person was already checked in elsewhere: Ada.",
    );
  });

  test("a page without the door's cache key stops the wire-up", () => {
    const parts = fakePage();
    delete parts.container.dataset.doorCacheKey;
    // A page the older template rendered carries no cache key, so the
    // offline mode cannot digest a scan against its saved list. The
    // wire-up throws rather than half-wire the offline mode.
    expect(() =>
      setupOfflineScanner({
        admitOne: async () => checkedIn(),
        container: parts.container as unknown as HTMLElement,
        doorCacheKey: parts.container.dataset.doorCacheKey ?? "",
        post: async () => checkedIn(),
        showStatus,
        statusEl: parts.status as unknown as HTMLElement,
        tokensPath: TOKENS_PATH,
      }),
    ).toThrow("No door cache key on the scanner page");
  });

  test("a message hole with no value renders empty", () => {
    expect(
      interpolate("{count} check-ins waiting to send.", { count: 2 }),
    ).toBe("2 check-ins waiting to send.");
    expect(interpolate("{name} was already checked in elsewhere.", {})).toBe(
      " was already checked in elsewhere.",
    );
  });
});
