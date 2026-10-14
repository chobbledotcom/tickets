import type { Config } from "@libsql/client";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { createDatabaseClient, databaseFetch } from "#db/database-client.ts";
import { hranaTestFetch } from "#test-utils/hrana.ts";

/** The engine hands the configured fetch its own Request object; the client
 *  rebuilds it as a native request and forwards the engine's call arguments.
 *  The stub captures what reaches Deno's fetch boundary, and the fake's
 *  protocol replies answer the request. */
/** The stub records every native request that reaches the fetch boundary
 *  and answers with `reply`, or with an empty pipeline reply when the
 *  caller passes none. Restore the stub after the call. */
const captureBoundary = (
  reply: (request: Request) => Promise<Response> = () =>
    Promise.resolve(
      Response.json({ base_url: null, baton: null, results: [] }),
    ),
) => {
  const boundary: { init: RequestInit | undefined; request: Request }[] = [];
  const fetched = stub(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!(input instanceof Request)) {
        throw new Error("The adapter must hand the boundary a Request");
      }
      boundary.push({ init, request: input.clone() });
      return reply(input);
    },
  );
  return { boundary, fetched };
};

/** The first request the boundary captured, or a failure when none. */
const firstSent = (
  boundary: { init: RequestInit | undefined; request: Request }[],
) => {
  const [sent] = boundary;
  if (!sent) throw new Error("The boundary captured no request");
  return sent;
};

describe("database request conversion", () => {
  test("rebuilds the engine's request as a native request at the fetch boundary", async () => {
    const remote = hranaTestFetch();
    const { boundary, fetched } = captureBoundary((request) =>
      remote.fetch(request),
    );
    try {
      const client = createDatabaseClient({ url: "libsql://pipeline.test" });
      await client.execute("SELECT 42");
      client.close();
    } finally {
      fetched.restore();
    }
    expect(boundary.length).toBe(1);
    const sent = firstSent(boundary);
    expect(sent.request.url).toBe("https://pipeline.test/v2/pipeline");
    expect(sent.request.method).toBe("POST");
    expect(sent.request.headers.get("content-type")).toContain(
      "application/json",
    );
    const envelope = JSON.parse(await sent.request.text()) as {
      requests: { stmt?: { sql?: string }; type?: string }[];
    };
    const executed = envelope.requests.find(
      (operation) => operation.type === "execute",
    );
    expect(executed?.stmt?.sql).toBe("SELECT 42");
    // The engine passes no second argument today; the override forwards
    // whatever it receives, so a future caller's init reaches the boundary.
    expect(sent.init).toBeUndefined();
  });

  test("forwards a caller's init to the fetch boundary unchanged", async () => {
    const engineInit: RequestInit = {
      body: "override-body",
      cache: "no-store",
      headers: { "x-override": "yes" },
      method: "PUT",
    };
    const { boundary, fetched } = captureBoundary();
    try {
      const engineRequest = new Request("https://pipeline.test/v2/pipeline", {
        body: '{"requests":[]}',
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      await databaseFetch(engineRequest, engineInit);
    } finally {
      fetched.restore();
    }
    expect(boundary.length).toBe(1);
    const sent = firstSent(boundary);
    expect(sent.init).toBe(engineInit);
    expect(sent.init?.method).toBe("PUT");
    expect(sent.init?.body).toBe("override-body");
    expect(sent.init?.headers).toEqual({ "x-override": "yes" });
    expect(sent.init?.cache).toBe("no-store");
    expect(sent.request.url).toBe("https://pipeline.test/v2/pipeline");
  });

  test("keeps the adapter when the caller's fetch is undefined", async () => {
    const remote = hranaTestFetch();
    const { boundary, fetched } = captureBoundary((request) =>
      remote.fetch(request),
    );
    try {
      // The shape the bug erases: a spread caller's config leaves the key
      // present but undefined, a state Config's types cannot name.
      const callerConfig = {
        fetch: undefined,
        url: "libsql://pipeline.test",
      } as unknown as Config;
      const client = createDatabaseClient(callerConfig);
      await client.execute("SELECT 1");
      client.close();
    } finally {
      fetched.restore();
    }
    expect(boundary.length).toBe(1);
    const sent = firstSent(boundary);
    // The library's fallback would hand the boundary its own Request type.
    expect(sent.request).toBeInstanceOf(Request);
    expect(sent.request.url).toBe("https://pipeline.test/v2/pipeline");
  });

  test("carries a binary request body to the boundary byte for byte", async () => {
    // 0x9f 0x92 0x96 0xff are not valid UTF-8; a text read replaces them
    // with the replacement character before the boundary sees them.
    const bytes = new Uint8Array([0, 0x9f, 0x92, 0x96, 0xff, 1]);
    const { boundary, fetched } = captureBoundary();
    try {
      const engineRequest = new Request("https://pipeline.test/v2/pipeline", {
        body: bytes,
        headers: { "content-type": "application/octet-stream" },
        method: "POST",
      });
      await databaseFetch(engineRequest);
    } finally {
      fetched.restore();
    }
    expect(boundary.length).toBe(1);
    const sent = firstSent(boundary);
    const sentBytes = new Uint8Array(await sent.request.arrayBuffer());
    expect(sentBytes).toEqual(bytes);
  });

  test("dispatches a bodyless GET without a request body", async () => {
    const { boundary, fetched } = captureBoundary();
    try {
      const engineRequest = new Request("https://pipeline.test/v2/pipeline", {
        method: "GET",
      });
      await databaseFetch(engineRequest);
    } finally {
      fetched.restore();
    }
    expect(boundary.length).toBe(1);
    const sent = firstSent(boundary);
    expect(sent.request.method).toBe("GET");
    expect(sent.request.body).toBeNull();
  });
});
