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
 *  caller passes none. It honours the signal the way real fetch does: an
 *  already-aborted signal rejects before the call is recorded, and an
 *  abort during the call rejects the pending fetch. Restore the stub
 *  after the call. */
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
      const signal = init?.signal ?? input.signal;
      if (signal?.aborted) {
        throw new DOMException("The operation was aborted", "AbortError");
      }
      boundary.push({ init, request: input.clone() });
      if (signal === null || signal === undefined) return reply(input);
      // The race settles on the first of the reply and the abort, and no
      // frame suspends on the loser: an abort during a held reply rejects
      // the pending fetch, and the reply's promise stays unreferenced
      // instead of keeping a suspended await alive past the run.
      const aborted = new Promise<never>((_, rejectAbort) => {
        signal.addEventListener(
          "abort",
          () =>
            rejectAbort(
              new DOMException("The operation was aborted", "AbortError"),
            ),
          { once: true },
        );
      });
      return Promise.race([reply(input), aborted]);
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

/** A reply the test holds in flight and settles itself in its finally, so
 *  no promise stays pending past the run. */
const heldReply = () => {
  let release: ((response: Response) => void) | undefined;
  const promise = new Promise<Response>((resolve) => {
    release = (response) => resolve(response);
  });
  return { promise, release: () => release?.(Response.json({})) };
};

/** Start the adapter call and yield until the dispatch has landed at the
 *  boundary. The pending work travels in an object: awaiting a bare
 *  pending promise would adopt it, and the test's continuation would then
 *  wait for a settlement only its own abort can cause. */
const dispatched = async (
  run: () => Promise<Response>,
  boundary: unknown[],
) => {
  const pending = run();
  for (let i = 0; i < 1000 && boundary.length === 0; i += 1) {
    await Promise.resolve();
  }
  expect(boundary.length).toBe(1);
  return { pending };
};

/** Dispatch a JSON POST carrying both signals, and wait for the dispatch
 *  to land. */
const dispatchBothSignals = (
  inputController: AbortController,
  initController: AbortController,
  boundary: unknown[],
) =>
  dispatched(
    () =>
      databaseFetch(jsonPost(inputController.signal), {
        signal: initController.signal,
      }),
    boundary,
  );

/** A POST engine request with a JSON body and an abort signal, the shape
 *  the abort regressions cancel. */
const jsonPost = (signal: AbortSignal) =>
  new Request("https://pipeline.test/v2/pipeline", {
    body: '{"requests":[]}',
    headers: { "content-type": "application/json" },
    method: "POST",
    signal,
  });

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

  test("rejects an already-aborted input before the dispatch", async () => {
    const controller = new AbortController();
    controller.abort();
    const { boundary, fetched } = captureBoundary();
    try {
      await expect(
        databaseFetch(jsonPost(controller.signal)),
      ).rejects.toThrow();
    } finally {
      fetched.restore();
    }
    expect(boundary).toEqual([]);
  });

  test("an input-only abort after the dispatch cancels the fetch", async () => {
    const controller = new AbortController();
    const gate = heldReply();
    const { boundary, fetched } = captureBoundary(() => gate.promise);
    try {
      const { pending } = await dispatched(
        () => databaseFetch(jsonPost(controller.signal)),
        boundary,
      );
      controller.abort();
      await expect(pending).rejects.toThrow();
    } finally {
      fetched.restore();
      gate.release();
    }
  });

  test("an input abort does not cancel a request that carries an init signal", async () => {
    const inputController = new AbortController();
    const initController = new AbortController();
    let canned: Response | undefined;
    let releaseReply: (() => void) | undefined;
    const { boundary, fetched } = captureBoundary(
      () =>
        new Promise<Response>((resolve) => {
          releaseReply = () => {
            canned = Response.json({});
            resolve(canned);
          };
        }),
    );
    try {
      const { pending } = await dispatchBothSignals(
        inputController,
        initController,
        boundary,
      );
      // Aborting the input's signal must not cancel a request whose init
      // carries its own signal: the request still fulfills.
      inputController.abort();
      await Promise.resolve();
      expect(boundary.length).toBe(1);
      releaseReply?.();
      const reply = await pending;
      expect(reply).toBe(canned);
    } finally {
      fetched.restore();
      releaseReply?.();
    }
  });

  test("aborting the explicit init signal cancels the held fetch", async () => {
    const inputController = new AbortController();
    const initController = new AbortController();
    const gate = heldReply();
    const { boundary, fetched } = captureBoundary(() => gate.promise);
    try {
      const { pending } = await dispatchBothSignals(
        inputController,
        initController,
        boundary,
      );
      initController.abort();
      await expect(pending).rejects.toThrow();
    } finally {
      fetched.restore();
      gate.release();
    }
  });

  test("runs the dispatch guard after every await, before the boundary", async () => {
    // The engine request is a stand-in whose body read the test gates: the
    // adapter only reads url, method, headers, body, and arrayBuffer
    // through the object's own API, which is exactly what this shape
    // provides.
    let releaseBody: (() => void) | undefined;
    const engineRequest = {
      arrayBuffer: () =>
        new Promise<ArrayBuffer>((resolve) => {
          releaseBody = () => resolve(new ArrayBuffer(0));
        }),
      body: new Uint8Array(0),
      headers: new Headers({ "content-type": "application/json" }),
      method: "POST",
      url: "https://pipeline.test/v2/pipeline",
    } as unknown as Request; // the adapter's contract is the object's own API
    const boundary: { init: RequestInit | undefined }[] = [];
    let guardRan = false;
    let poolMoved = false;
    const fetched = stub(
      globalThis,
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!(input instanceof Request)) {
          throw new Error("The adapter must hand the boundary a Request");
        }
        boundary.push({ init });
        return Response.json({ base_url: null, baton: null, results: [] });
      },
    );
    try {
      const pending = databaseFetch(engineRequest, undefined, () => {
        guardRan = true;
        if (poolMoved) {
          throw new Error("The database client is closed");
        }
      });
      // The pool moves on while the adapter holds the gated body read; the
      // guard must reject the request at the boundary, after every await.
      poolMoved = true;
      releaseBody?.();
      await expect(pending).rejects.toThrow("The database client is closed");
    } finally {
      fetched.restore();
    }
    expect(guardRan).toBe(true);
    expect(boundary).toEqual([]);
  });
});
