/** The offline shell's strategies: the worker answers only the scanner page
 * and its bundle, saves what it fetched, and drops old cache versions. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  cacheShell,
  dropOldCaches,
  type FetchEventLike,
  handleFetch,
  scannerAssetResponse,
  scannerPageResponse,
} from "#src/ui/client/scanner-service-worker.ts";
import { createGlobalStash } from "#test-utils/happy-dom.ts";

const CACHE = "scanner-shell-v1";

/** The fake cache storage's read side, for assertions. */
type FakeCaches = {
  restore: () => void;
  saved: (key: string) => Promise<Response | undefined>;
  storeNames: () => string[];
};

/** An in-memory CacheStorage double. `put` keys by the raw request value,
 * so a URL-string save lands under that URL. */
const fakeCaches = (): FakeCaches => {
  const stores = new Map<string, Map<string, Response>>();
  const stash = createGlobalStash();
  stash.set("caches", {
    delete: (name: string) => stores.delete(name),
    keys: () => [...stores.keys()],
    match: (request: Request) => stores.get(CACHE)?.get(request.url),
    open: (name: string) => {
      const store = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, store);
      return {
        put: (request: Request | string, response: Response) => {
          store.set(
            typeof request === "string" ? request : request.url,
            response.clone(),
          );
        },
      };
    },
  });
  return {
    restore: () => stash.restore(),
    /** The copy the shell stored under one raw key, if any. */
    saved: async (key: string): Promise<Response | undefined> =>
      stores.get(CACHE)?.get(key),
    storeNames: () => [...stores.keys()],
  };
};

/** Run one test with the fake cache storage and one stubbed network. The
 * fake's handle reaches the test, so assertions read the same store the
 * worker wrote. */
const withNetwork = (
  fetchImpl: (request: Request) => Response,
  run: (handle: FakeCaches) => Promise<void>,
): Promise<void> => {
  const cachesHandle = fakeCaches();
  const stash = createGlobalStash();
  stash.set("fetch", fetchImpl);
  return run(cachesHandle).finally(() => {
    stash.restore();
    cachesHandle.restore();
  });
};

/** A fetch event double that records what the worker answers. */
const fetchEvent = (
  request: Request,
): {
  answered: () => Promise<Response> | Response | undefined;
  event: FetchEventLike;
} => {
  let answered: Promise<Response> | Response | undefined;
  return {
    answered: () => answered,
    event: {
      request,
      respondWith: (response) => {
        answered = response;
      },
      waitUntil: () => {},
    },
  };
};

describe("the scanner's offline shell", () => {
  test("install saves the scanner bundle", async () => {
    await withNetwork(
      () => new Response("// bundle"),
      async (handle) => {
        await cacheShell();
        expect(await (await handle.saved("/scanner.js"))?.text()).toBe(
          "// bundle",
        );
      },
    );
  });

  test("activation drops the previous shell's cache", async () => {
    const handle = fakeCaches();
    try {
      await caches.open("scanner-shell-v0");
      await caches.open(CACHE);
      await dropOldCaches();
      expect(handle.storeNames()).toEqual([CACHE]);
    } finally {
      handle.restore();
    }
  });

  test("serves the fresh page and saves a copy", async () => {
    await withNetwork(
      () => new Response("<html>fresh</html>"),
      async () => {
        const request = new Request(
          "https://site.test/admin/listing/7/scanner",
        );
        const res = await scannerPageResponse(request);
        expect(await res.text()).toBe("<html>fresh</html>");
        expect(await (await caches.match(request))?.text()).toBe(
          "<html>fresh</html>",
        );
      },
    );
  });

  test("an offline reload reads the last saved copy", async () => {
    await withNetwork(
      () => {
        throw new TypeError("offline");
      },
      async () => {
        const request = new Request(
          "https://site.test/admin/listing/7/scanner",
        );
        const cache = await caches.open(CACHE);
        await cache.put(request, new Response("<html>saved</html>"));
        const res = await scannerPageResponse(request);
        expect(await res.text()).toBe("<html>saved</html>");
      },
    );
  });

  test("offline with no saved copy fails the navigation as before", async () => {
    await withNetwork(
      () => {
        throw new TypeError("offline");
      },
      async () => {
        const request = new Request(
          "https://site.test/admin/listing/7/scanner",
        );
        await expect(scannerPageResponse(request)).rejects.toThrow(TypeError);
      },
    );
  });

  test("the saved bundle answers before the network", async () => {
    await withNetwork(
      () => new Response("// fresh"),
      async () => {
        const request = new Request("https://site.test/scanner.js");
        const cache = await caches.open(CACHE);
        await cache.put(request, new Response("// saved"));
        expect(await (await scannerAssetResponse(request)).text()).toBe(
          "// saved",
        );
      },
    );
  });

  test("an unsaved bundle is fetched and saved", async () => {
    await withNetwork(
      () => new Response("// fresh"),
      async () => {
        const request = new Request("https://site.test/scanner.js");
        expect(await (await scannerAssetResponse(request)).text()).toBe(
          "// fresh",
        );
        expect(await (await caches.match(request))?.text()).toBe("// fresh");
      },
    );
  });

  test("the worker answers the scanner page and its bundle", async () => {
    await withNetwork(
      () => new Response("<html>fresh</html>"),
      async () => {
        const page = fetchEvent(
          new Request("https://site.test/admin/listing/7/scanner", {
            mode: "navigate" as RequestMode,
          }),
        );
        handleFetch(page.event);
        expect(await page.answered()).toBeInstanceOf(Response);

        const groupPage = fetchEvent(
          new Request("https://site.test/admin/groups/3/scanner", {
            mode: "navigate" as RequestMode,
          }),
        );
        handleFetch(groupPage.event);
        expect(await groupPage.answered()).toBeInstanceOf(Response);

        const bundle = fetchEvent(new Request("https://site.test/scanner.js"));
        handleFetch(bundle.event);
        expect(await bundle.answered()).toBeInstanceOf(Response);
      },
    );
  });

  test("the token list, other admin pages, and posts pass through untouched", () => {
    const handle = fakeCaches();
    try {
      const tokens = fetchEvent(
        new Request("https://site.test/admin/listing/7/scan-tokens"),
      );
      handleFetch(tokens.event);
      expect(tokens.answered()).toBeUndefined();

      const otherAdmin = fetchEvent(new Request("https://site.test/admin/"));
      handleFetch(otherAdmin.event);
      expect(otherAdmin.answered()).toBeUndefined();

      const scan = fetchEvent(
        new Request("https://site.test/admin/listing/7/scan", {
          method: "POST",
        }),
      );
      handleFetch(scan.event);
      expect(scan.answered()).toBeUndefined();
    } finally {
      handle.restore();
    }
  });
});
