import { Request as CrossFetchRequest } from "npm:cross-fetch@4.1.0";
import { Request as NodeFetchRequest } from "npm:node-fetch@3.3.2";
import type { Client } from "@libsql/client";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { type Spy, spy, stub } from "@std/testing/mock";
import { createDatabaseClient, PROXY_ENV_NAMES } from "#db/database-client.ts";
import { hranaTestFetch } from "#test-utils/hrana.ts";

type WatchedPool = {
  pool: Deno.HttpClient;
  options: Deno.CreateHttpClientOptions;
  close: Spy;
};

/** Record each pool the client opens, and answer its requests from a test
 * database. `onCreate` runs inside the adapter call, right after the pool is
 * selected — the seam the body-read-gated tests close the client from. */
const watchPools = (onCreate?: () => void) => {
  const restoreProxy = clearProxyEnvs();
  const create = Deno.createHttpClient;
  const pools: WatchedPool[] = [];
  const created = stub(Deno, "createHttpClient", (options) => {
    // Deno fills in defaults on the options it receives, so keep a copy.
    const asked = { ...options };
    const pool = create(options);
    pools.push({ close: spy(pool, "close"), options: asked, pool });
    onCreate?.();
    return pool;
  });
  const remote = hranaTestFetch();
  const usedPools: (Deno.HttpClient | undefined)[] = [];
  const fetched = stub(globalThis, "fetch", (input, init) => {
    usedPools.push(init?.client);
    return remote.fetch(input as Request);
  });
  return {
    pools,
    usedPools,
    [Symbol.dispose]: () => {
      created.restore();
      fetched.restore();
      restoreProxy();
    },
  };
};

const openClient = () =>
  createDatabaseClient({ url: "libsql://pipeline.test" });

/** The proxy environment decides whether the client builds a pool, so the
 *  fixtures clear the proxy variables the runner's environment may carry
 *  and restore them when the fixture ends. */
const clearProxyEnvs = () => {
  const saved = PROXY_ENV_NAMES.map(
    (name) => [name, process.env[name]] as const,
  );
  for (const name of PROXY_ENV_NAMES) {
    delete process.env[name];
  }
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
};

/** The close-during-read fixture: one close queues at the first pool
 *  selection and runs inside the adapter's body-read suspension, before
 *  the boundary call. */
const openWithQueuedClose = () => {
  const state = { closed: false };
  let client: Client | undefined;
  const watched = watchPools(() => {
    if (!state.closed) {
      queueMicrotask(() => {
        client?.close();
        state.closed = true;
      });
    }
  });
  client = openClient();
  return { client, state, watched };
};

/** Yield microtasks until the queued close has run inside the body read.
 *  Bounded, so a broken ordering fails instead of hanging the run. */
const waitUntilClosed = async (state: { closed: boolean }) => {
  for (let i = 0; i < 1000 && !state.closed; i += 1) {
    await Promise.resolve();
  }
  if (!state.closed) {
    throw new Error("The queued close never ran during the body read");
  }
};

/** A real Hrana endpoint on the loopback. The client's requests cross real
 *  sockets; the fake's protocol replies answer them, and the server records
 *  the client address each request arrived on, so the tests can tell one
 *  connection from another. Fetch runs un-stubbed, and the pool wrapper only
 *  records, so what the tests see is the runtime's own socket retirement. */
const openLoopback = (replyDelayMs = 0) => {
  const restoreProxy = clearProxyEnvs();
  const remote = hranaTestFetch();
  const connections: string[] = [];
  const options: Deno.CreateHttpClientOptions[] = [];
  const create = Deno.createHttpClient;
  const created = stub(Deno, "createHttpClient", (asked) => {
    // Deno fills in defaults on the options it receives, so keep a copy.
    // The tests record what production asked and hand the real constructor
    // the short timeout the window tests wait out.
    options.push({ ...asked });
    return create({ ...asked, poolIdleTimeout: REAL_POOL_IDLE_TIMEOUT_MS });
  });
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0 },
    async (request, info) => {
      const { hostname, port } = info.remoteAddr;
      connections.push(`${hostname}:${port}`);
      const reply = await remote.fetch(request);
      if (replyDelayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, replyDelayMs));
      }
      return reply;
    },
  );
  return {
    connections,
    options,
    url: `http://127.0.0.1:${server.addr.port}`,
    [Symbol.asyncDispose]: async () => {
      created.restore();
      restoreProxy();
      await server.shutdown();
    },
  };
};

/** The pool retires an idle socket only on its own clock, so the window
 *  tests wait out real time. No fake clock reaches Deno's socket pool. The
 *  production option (20 seconds, asserted in the first test) would make
 *  each wait 21 seconds, so the fixture records what production asked and
 *  passes the real constructor a one-second timeout instead; the past-the-
 *  window wait sits just above it. */
const REAL_POOL_IDLE_TIMEOUT_MS = 1_000;
const PAST_THE_IDLE_WINDOW_MS = 1_100;
const waitPastTheIdleWindow = () =>
  new Promise<void>((resolve) => setTimeout(resolve, PAST_THE_IDLE_WINDOW_MS));

/** Await the request's rejection, yield out any late dispatch the guard
 *  failed to stop, and require the boundary untouched. The raw client's
 *  own close or reconnect rejection may win the race, so the assertion
 *  checks the rejection rather than one message. */
const expectRejectedAndUndispatched = async (
  pending: Promise<unknown>,
  watched: { pools: WatchedPool[]; usedPools: (Deno.HttpClient | undefined)[] },
) => {
  await expect(pending).rejects.toThrow();
  for (let i = 0; i < 1000 && watched.usedPools.length === 0; i += 1) {
    await Promise.resolve();
  }
  expect(watched.usedPools).toEqual([]);
  expect(watched.pools).toEqual([]);
};

describe("database connection pool", () => {
  test("requests within the idle window reuse one real connection", async () => {
    await using loopback = openLoopback();
    const client = createDatabaseClient({ url: loopback.url });
    await client.batch(["SELECT 1"], "write");
    await client.execute("SELECT 2");
    client.close();
    expect(loopback.options).toEqual([{ poolIdleTimeout: 20_000 }]);
    expect(loopback.connections.length).toBeGreaterThanOrEqual(2);
    expect(new Set(loopback.connections).size).toBe(1);
  });

  test("a request after the idle window opens a fresh connection", async () => {
    await using loopback = openLoopback();
    const client = createDatabaseClient({ url: loopback.url });
    await client.execute("SELECT 1");
    await waitPastTheIdleWindow();
    const result = await client.execute("SELECT 2");
    client.close();
    expect(result.rows).toEqual([]);
    expect(loopback.connections.length).toBe(2);
    expect(loopback.connections[0]).not.toBe(loopback.connections[1]);
  });

  test("a reply held past the idle window still returns", async () => {
    await using loopback = openLoopback(PAST_THE_IDLE_WINDOW_MS);
    const client = createDatabaseClient({ url: loopback.url });
    const result = await client.execute("SELECT 1");
    await client.execute("SELECT 2");
    client.close();
    expect(result.rows).toEqual([]);
    expect(loopback.connections.length).toBe(2);
    expect(new Set(loopback.connections).size).toBe(1);
  });

  test("close is safe to repeat, and reconnect opens a fresh pool", async () => {
    using watched = watchPools();
    const client = openClient();
    await client.execute("SELECT 1");
    client.close();
    client.close();
    client.reconnect();
    await client.execute("SELECT 2");
    client.close();
    expect(watched.pools.map(({ close }) => close.calls.length)).toEqual([
      1, 1,
    ]);
    expect(watched.usedPools).toEqual(watched.pools.map(({ pool }) => pool));
  });

  test("a client closed before any request opens no pool", () => {
    using watched = watchPools();
    openClient().close();
    expect(watched.pools).toEqual([]);
  });

  test("a proxy deployment skips the custom pool", async () => {
    using watched = watchPools();
    process.env.HTTPS_PROXY = "http://proxy.test:8080";
    const client = openClient();
    await client.execute("SELECT 1");
    client.close();
    // The custom client knows no proxy: the requests go through the
    // default fetch, whose proxy support the runtime applies.
    expect(watched.usedPools).toEqual([undefined]);
    expect(watched.pools).toEqual([]);
  });

  test("a close on the proxy path rejects the request before it dispatches", async () => {
    using watched = watchPools();
    process.env.HTTPS_PROXY = "http://proxy.test:8080";
    const client = openClient();
    const pending = client.execute("SELECT 1");
    client.close();
    await expectRejectedAndUndispatched(pending, watched);
  });

  test("a reconnect on the proxy path rejects the suspended request", async () => {
    using watched = watchPools();
    process.env.HTTPS_PROXY = "http://proxy.test:8080";
    const client = openClient();
    // The reconnect must land while the wrapper's body read is suspended.
    // The library's requests are node-fetch Requests — a different realm
    // from the test's global Request — so the hold gates that class's
    // read: it signals entry after the original read succeeds, the test
    // awaits the signal before reconnecting, and releases the hold
    // afterward.
    let heldOnce = false;
    let signalEntry: (() => void) | undefined;
    let releaseBody: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      signalEntry = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    const holdRead = (klass: {
      prototype: { arrayBuffer: () => Promise<ArrayBuffer> };
    }) => {
      const original = klass.prototype.arrayBuffer;
      klass.prototype.arrayBuffer = async function () {
        const buffer = await Reflect.apply(original, this, []);
        if (heldOnce) return buffer;
        heldOnce = true;
        signalEntry?.();
        await held;
        return buffer;
      };
      return () => {
        klass.prototype.arrayBuffer = original;
      };
    };
    const restoreNode = holdRead(NodeFetchRequest);
    const restoreCross = holdRead(CrossFetchRequest);
    try {
      const pending = client.execute("SELECT 1");
      // The hold must gate the read. If the request settles first, the
      // entry signal never came from a suspended read: fail the test so
      // the finally restores the patched prototypes.
      const settled = pending.then(
        () => "settled",
        () => "settled",
      ) as Promise<"entered" | "settled">;
      const outcome = await Promise.race([
        entered.then(() => "entered" as const),
        settled,
      ]);
      if (outcome === "settled") {
        throw new Error(
          "The request settled before the body read signalled entry",
        );
      }
      client.reconnect();
      releaseBody?.();
      await expectRejectedAndUndispatched(pending, watched);
    } finally {
      restoreNode();
      restoreCross();
      releaseBody?.();
    }
  });

  test("a caller's own fetch replaces the pool", async () => {
    using watched = watchPools();
    const remote = hranaTestFetch();
    const client = createDatabaseClient({
      fetch: remote.fetch,
      url: "libsql://pipeline.test",
    });
    await client.batch(["SELECT 1"], "write");
    client.close();
    expect(watched.pools).toEqual([]);
    expect(watched.usedPools).toEqual([]);
    expect(remote.requests.length).toBe(1);
  });

  test("a local database opens no pool", async () => {
    using watched = watchPools();
    const client = createDatabaseClient({ url: ":memory:" });
    await client.execute("SELECT 1");
    client.close();
    expect(watched.pools).toEqual([]);
  });

  test("close during the body read rejects the request before it dispatches", async () => {
    const opened = openWithQueuedClose();
    using watched = opened.watched;
    const pending = opened.client.execute("SELECT 1");
    await waitUntilClosed(opened.state);
    await expect(pending).rejects.toThrow("The database client is closed");
    expect(watched.usedPools).toEqual([]);
    expect(watched.pools[0]?.close.calls.length).toBe(1);
  });

  test("work started after a reconnect dispatches on the fresh pool", async () => {
    const opened = openWithQueuedClose();
    using watched = opened.watched;
    const stale = opened.client.execute("SELECT 1");
    await waitUntilClosed(opened.state);
    opened.client.reconnect();
    const fresh = await opened.client.execute("SELECT 2");
    opened.client.close();
    await expect(stale).rejects.toThrow("The database client is closed");
    expect(fresh.rows).toEqual([]);
    expect(watched.pools.length).toBe(2);
    expect(watched.usedPools).toEqual([watched.pools[1]?.pool]);
    expect(watched.pools[0]?.close.calls.length).toBe(1);
  });
});
