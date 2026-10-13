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
 * database. */
const watchPools = () => {
  const create = Deno.createHttpClient;
  const pools: WatchedPool[] = [];
  const created = stub(Deno, "createHttpClient", (options) => {
    // Deno fills in defaults on the options it receives, so keep a copy.
    const asked = { ...options };
    const pool = create(options);
    pools.push({ close: spy(pool, "close"), options: asked, pool });
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

/** A real Hrana endpoint on the loopback. The client's requests cross real
 *  sockets; the fake's protocol replies answer them, and the server records
 *  the client address each request arrived on, so the tests can tell one
 *  connection from another. Fetch runs un-stubbed, and the pool wrapper only
 *  records, so what the tests see is the runtime's own socket behavior. */
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
    [Symbol.dispose]: () => {
      created.restore();
      void server.shutdown();
    },
  };
};

describe("database connection pool", () => {
  test("consecutive requests reuse one real connection", async () => {
    using loopback = openLoopback();
    const client = createDatabaseClient({ url: loopback.url });
    await client.batch(["SELECT 1"], "write");
    await client.execute("SELECT 2");
    client.close();
    expect(loopback.connections.length).toBeGreaterThanOrEqual(2);
    expect(new Set(loopback.connections).size).toBe(1);
  });

  test("close is safe to repeat, and reconnect keeps working", async () => {
    using watched = watchPools();
    const client = openClient();
    await client.execute("SELECT 1");
    client.close();
    client.close();
    client.reconnect();
    await client.execute("SELECT 2");
    client.close();
    expect(watched.usedPools).toEqual([undefined, undefined]);
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
});
