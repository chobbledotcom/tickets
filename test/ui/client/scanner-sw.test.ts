/// <reference lib="dom" />

/**
 * The scanner service worker's asset serving: the stored copy answers a
 * cache-busted request under the bare pathname, a good refresh replaces it,
 * a deploy's error page never lands in the store, and a door with nothing
 * stored and no connection still gets a defined answer.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { createGlobalStash } from "#test-utils/happy-dom.ts";

// The worker registers its listeners on import; the test dispatches fetch
// events at the page's own global scope.
import "#src/ui/client/scanner-sw.js";

/** The store the worker reads as the browser's Cache Storage, holding its
 * entries where a test can read them. */
class FakeCache {
  readonly entries = new Map<string, Response>();

  async match(key: string): Promise<Response | undefined> {
    const entry = this.entries.get(String(key));
    // A real cache answers every match with its own copy of the body.
    return entry?.clone();
  }

  async put(key: string | Request, response: Response): Promise<void> {
    this.entries.set(String(key), response);
  }
}

const SITE = "https://door.example.com";

/** The fetch event the page's scope dispatches, carrying the request and
 * the answer slot the worker hands its response to. */
class FakeFetchEvent extends Event {
  request: Request;
  respondWith: (handled: Promise<Response>) => void;

  constructor(
    request: Request,
    respondWith: (handled: Promise<Response>) => void,
  ) {
    super("fetch");
    this.request = request;
    this.respondWith = respondWith;
  }
}

/** The install or activate event the page's scope dispatches, holding the
 * promises the worker hands to waitUntil. */
class FakeLifecycleEvent extends Event {
  readonly waited: Promise<unknown>[] = [];

  waitUntil(promise: Promise<unknown>): void {
    this.waited.push(promise);
  }
}

describe("the scanner service worker's stored assets", () => {
  // Deno's own `caches` global is a getter-only accessor, so the fake store
  // goes in through the stash, which records the original descriptor.
  const stash = createGlobalStash();
  let cache: FakeCache;

  /** Install the fake store, seed it, and send one asset request through
   * the worker's fetch handler, as the page's own scope does. */
  const fireFetch = async (
    path: string,
    seed?: (store: FakeCache) => void,
  ): Promise<Response | undefined> => {
    cache = new FakeCache();
    stash.set("caches", { open: () => cache });
    seed?.(cache);
    let answered: Promise<Response> | undefined;
    const event = new FakeFetchEvent(
      new Request(`${SITE}${path}`),
      (handled) => {
        answered = handled;
      },
    );
    self.dispatchEvent(event);
    const response = await answered;
    for (let hop = 0; hop < 10; hop++) await Promise.resolve();
    return response;
  };

  afterEach(() => {
    stash.restore();
  });

  /** Seed one stored scanner.js copy and send one cache-busted request for
   * it, with the network answering or failing as the test says. */
  const fireSeededScannerFetch = async (
    network: Response | Error,
  ): Promise<Response | undefined> => {
    using _fetch = stubFetch(network);
    // The await holds this scope, and the stub with it, until the worker's
    // own fetch is done.
    return await fireFetch("/scanner.js?ts=2026102101", (store) =>
      store.entries.set("/scanner.js", new Response("stored")),
    );
  };

  test("serves the network's fresh copy online and replaces the store", async () => {
    const answered = await fireSeededScannerFetch(new Response("fresh"));

    // The online door reads the new build at once, though the request carried
    // the cache-buster, so a deploy never runs old client code against new
    // markup.
    expect(answered?.status).toBe(200);
    expect(await answered?.text()).toBe("fresh");
    // The store holds the fresh copy under the bare pathname, so the next
    // build's request reads it and no variant piles up.
    expect([...cache.entries.keys()]).toEqual(["/scanner.js"]);
    expect(await cache.entries.get("/scanner.js")?.text()).toBe("fresh");
  });

  test("serves the stored copy when the network is down", async () => {
    const answered = await fireSeededScannerFetch(new Error("offline"));

    // The offline door reads the stored copy, though the request carried the
    // cache-buster.
    expect(answered?.status).toBe(200);
    expect(await answered?.text()).toBe("stored");
  });

  test("keeps a deploy's error page out of the store", async () => {
    using _fetch = stubFetch(new Response("boom", { status: 500 }));

    const answered = await fireFetch("/style.css");

    // The error still reaches the page, but nothing stored it.
    expect(answered?.status).toBe(500);
    expect([...cache.entries.keys()]).toEqual([]);
  });

  test("answers 503 when nothing is stored and the network is down", async () => {
    using _fetch = stubFetch(new Error("offline"));

    const answered = await fireFetch("/scanner.js");

    expect(answered?.status).toBe(503);
    expect([...cache.entries.keys()]).toEqual([]);
  });

  test("stores a first good answer under the bare pathname", async () => {
    using _fetch = stubFetch(new Response("first-body"));

    const answered = await fireFetch("/style.css?ts=1");

    expect(await answered?.text()).toBe("first-body");
    expect([...cache.entries.keys()]).toEqual(["/style.css"]);
  });

  test("keeps the fresh answer when the store rejects the write", async () => {
    using _fetch = stubFetch(new Response("fresh"));

    const answered = await fireFetch("/scanner.js", (store) => {
      store.put = async () => {
        throw new Error("The store is full");
      };
    });

    // The store is best effort: the fresh copy still serves the door, and
    // the next online visit writes it again.
    expect(await answered?.text()).toBe("fresh");
    expect([...cache.entries.keys()]).toEqual([]);
  });
});

describe("the scanner service worker's lifecycle", () => {
  // The worker reads skipWaiting and clients.claim off the global scope, so
  // the fake ones go in through the stash like the store.
  const stash = createGlobalStash();
  let cache: FakeCache;

  afterEach(() => {
    stash.restore();
  });

  /** Install the worker's lifecycle globals and one store, then dispatch one
   * lifecycle event, as the page's scope does. */
  const fireLifecycle = (
    type: "install" | "activate",
    store: Record<string, unknown> = { open: () => cache },
  ) => {
    cache = new FakeCache();
    stash.set("caches", store);
    const state = { claimed: 0, skipped: 0 };
    stash.set("skipWaiting", async () => {
      state.skipped++;
    });
    stash.set("clients", {
      claim: async () => {
        state.claimed++;
      },
    });
    const event = new FakeLifecycleEvent(type);
    self.dispatchEvent(event);
    return { event, state };
  };

  test("precaches both assets past the HTTP cache and skips waiting", async () => {
    const requested: [string, string | undefined][] = [];
    using _fetch = stubFetch((url, init) => {
      requested.push([url, init?.cache]);
      return new Response(`fresh for ${url}`);
    });

    const { event, state } = fireLifecycle("install");
    await event.waited[0];

    // Both bare assets arrive with the HTTP cache bypassed, so a worker
    // update stores the deploy's copies, never the browser's year-old ones.
    expect(requested).toEqual([
      ["/scanner.js", "reload"],
      ["/style.css", "reload"],
    ]);
    expect([...cache.entries.keys()]).toEqual(["/scanner.js", "/style.css"]);
    expect(await cache.entries.get("/scanner.js")?.text()).toBe(
      "fresh for /scanner.js",
    );
    expect(state.skipped).toBe(1);
  });

  test("fails the install when a precache fetch misses", async () => {
    using _fetch = stubFetch(new Response("boom", { status: 500 }));

    const { event } = fireLifecycle("install");

    // The old worker stays until a good install: an error page never lands
    // in the store.
    await expect(event.waited[0]).rejects.toThrow(
      "Precache failed for /scanner.js",
    );
    expect([...cache.entries.keys()]).toEqual([]);
  });

  test("clears the scanner's own old caches and claims the open pages", async () => {
    const deleted: string[] = [];
    const { event, state } = fireLifecycle("activate", {
      delete: async (name: string) => {
        deleted.push(name);
      },
      keys: async () => [
        "scanner-offline-assets",
        "scanner-offline-assets-2025",
        "unrelated-cache",
      ],
      open: () => cache,
    });
    await event.waited[0];

    // The renamed scanner caches go. The origin's other caches stay.
    expect(deleted).toEqual(["scanner-offline-assets-2025"]);
    expect(state.claimed).toBe(1);
  });
});

describe("the scanner service worker's fetch boundaries", () => {
  /** Send one request through the worker's fetch handler and return the
   * answer the worker handed to respondWith, if any. A navigate mode goes on
   * after construction: the Request constructor alone would drop it. */
  const fireRequest = async (
    path: string,
    init?: RequestInit,
  ): Promise<Response | undefined> => {
    const request = new Request(`${SITE}${path}`, init);
    if (init?.mode === "navigate") {
      Object.defineProperty(request, "mode", { value: "navigate" });
    }
    let answered: Promise<Response> | undefined;
    self.dispatchEvent(
      new FakeFetchEvent(request, (handled) => {
        answered = handled;
      }),
    );
    const response = await answered;
    for (let hop = 0; hop < 10; hop++) await Promise.resolve();
    return response;
  };

  test("answers an offline scanner navigation with the offline notice", async () => {
    using _fetch = stubFetch(new Error("offline"));

    const answered = await fireRequest("/admin/scanner", { mode: "navigate" });

    expect(answered?.status).toBe(200);
    expect(await answered?.text()).toContain("You are offline");
    expect(answered?.headers.get("content-type")).toContain("text/html");
  });

  test("passes an online scanner navigation through untouched", async () => {
    using _fetch = stubFetch(new Response("<html>door</html>"));

    const answered = await fireRequest("/admin/listing/7/scanner", {
      mode: "navigate",
    });

    // The rendered page carries guest details, so nothing stores it.
    expect(await answered?.text()).toBe("<html>door</html>");
  });

  test("leaves a scan post alone", async () => {
    const answered = await fireRequest("/admin/scan", { method: "POST" });

    // The scan POST carries live door state. The worker never answers it.
    expect(answered).toBeUndefined();
  });

  test("leaves a navigation the scanner does not own alone", async () => {
    const answered = await fireRequest("/admin/dashboard", {
      mode: "navigate",
    });

    expect(answered).toBeUndefined();
  });

  test("leaves a GET that is not a stored asset alone", async () => {
    const answered = await fireRequest("/admin.js");

    expect(answered).toBeUndefined();
  });
});
