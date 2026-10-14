import type { Client } from "@libsql/client";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { type Spy, spy, stub } from "@std/testing/mock";
import { createDatabaseClient } from "#db/database-client.ts";
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
    },
  };
};

const openClient = () =>
  createDatabaseClient({ url: "libsql://pipeline.test" });

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
  const remote = hranaTestFetch();
  const connections: string[] = [];
  const options: Deno.CreateHttpClientOptions[] = [];
  const create = Deno.createHttpClient;
  const created = stub(Deno, "createHttpClient", (asked) => {
    // Deno fills in defaults on the options it receives, so keep a copy.
    options.push({ ...asked });
    return create(asked);
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
      await server.shutdown();
    },
  };
};

/** The pool retires an idle socket only on its own 20-second clock (the
 *  option the tests record), so the window tests wait out real time. No
 *  fake clock reaches Deno's socket pool, and a shorter wait cannot tell
 *  the 20-second pool from the 90-second default it replaced. */
const PAST_THE_IDLE_WINDOW_MS = 21_000;
const waitPastTheIdleWindow = () =>
  new Promise<void>((resolve) => setTimeout(resolve, PAST_THE_IDLE_WINDOW_MS));

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
