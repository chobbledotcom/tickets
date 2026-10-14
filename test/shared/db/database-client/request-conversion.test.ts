import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { createDatabaseClient, databaseFetch } from "#db/database-client.ts";
import { hranaTestFetch } from "#test-utils/hrana.ts";

/** The engine hands the configured fetch its own Request object; the client
 *  rebuilds it as a native request and forwards the engine's call arguments.
 *  The stub captures what reaches Deno's fetch boundary, and the fake's
 *  protocol replies answer the request. */
describe("database request conversion", () => {
  test("rebuilds the engine's request as a native request at the fetch boundary", async () => {
    const remote = hranaTestFetch();
    const boundary: { init: RequestInit | undefined; request: Request }[] = [];
    const fetched = stub(globalThis, "fetch", ((
      input: Request,
      init?: RequestInit,
    ) => {
      boundary.push({ init, request: input.clone() });
      return remote.fetch(input);
    }) as typeof fetch);
    try {
      const client = createDatabaseClient({ url: "libsql://pipeline.test" });
      await client.execute("SELECT 42");
      client.close();
    } finally {
      fetched.restore();
    }
    expect(boundary.length).toBe(1);
    const [sent] = boundary;
    if (!sent) throw new Error("The override never reached the fetch boundary");
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
    const boundary: { init: RequestInit | undefined; request: Request }[] = [];
    const engineInit: RequestInit = {
      body: "override-body",
      cache: "no-store",
      headers: { "x-override": "yes" },
      method: "PUT",
    };
    const fetched = stub(
      globalThis,
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!(input instanceof Request)) {
          throw new Error("The adapter must hand the boundary a Request");
        }
        boundary.push({ init, request: input.clone() });
        return Response.json({ base_url: null, baton: null, results: [] });
      },
    );
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
    const [sent] = boundary;
    if (!sent) throw new Error("The adapter never reached the fetch boundary");
    expect(sent.init).toBe(engineInit);
    expect(sent.init?.method).toBe("PUT");
    expect(sent.init?.body).toBe("override-body");
    expect(sent.init?.headers).toEqual({ "x-override": "yes" });
    expect(sent.init?.cache).toBe("no-store");
    expect(sent.request.url).toBe("https://pipeline.test/v2/pipeline");
  });
});
