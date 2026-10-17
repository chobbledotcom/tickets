// test-groups: run-alone

import { EventEmitter } from "node:events";
import {
  type ClientRequest,
  request as httpRequest,
  type IncomingMessage,
} from "node:http";
import { Writable } from "node:stream";
import { createClient } from "@libsql/client";
import { assertExists } from "@std/assert";
import { expect } from "@std/expect";
import { join, toFileUrl } from "@std/path";
import { describe, it as test } from "@std/testing/bdd";
import {
  type DatabaseUploadTransport,
  uploadTursoDatabaseFile,
  verifyTursoUploadFile,
} from "#scripts/turso-migration-file.ts";
import { withTempDir } from "#test-utils/files.ts";
import { TEST_TURSO_CREDENTIALS } from "#test-utils/turso-api.ts";

const createSqliteFile = async (
  path: string,
  pragmas: string[],
): Promise<void> => {
  const client = createClient({ url: toFileUrl(path).href });
  try {
    for (const pragma of pragmas) await client.execute(pragma);
    await client.execute("CREATE TABLE example (value TEXT)");
    await client.execute("INSERT INTO example VALUES ('saved')");
    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    client.close();
  }
};

const uploadCredentials = (dbUrl: string) => ({
  ...TEST_TURSO_CREDENTIALS,
  dbUrl,
});

const withUploadServer = async (
  handler: (request: Request) => Response | Promise<Response>,
  run: (dbUrl: string, transport: DatabaseUploadTransport) => Promise<void>,
): Promise<void> => {
  const server = Deno.serve(
    { hostname: "127.0.0.1", onListen: () => {}, port: 0 },
    handler,
  );
  const address = server.addr;
  if (!("port" in address)) throw new Error("Expected a network address");
  // A server that answers before reading the body leaves the client still
  // streaming after the upload has already settled. Aborting those requests
  // here raises the break as each request's own "error" event, which the
  // upload's handler consumes. A socket-level destroy instead races the
  // polyfill's write task, which rejects with a bare "resource closed"
  // string no watch may eat — the uncaught error that failed two hosted
  // runs at an unknown location.
  const controllers: AbortController[] = [];
  const transport: DatabaseUploadTransport = {
    request: (url, options, receive) => {
      expect(url.protocol).toBe("https:");
      const localUrl = new URL(url);
      localUrl.protocol = "http:";
      const controller = new AbortController();
      // The caller's own signal keeps working: a combined signal aborts the
      // request when either side fires.
      options.signal = options.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal;
      controllers.push(controller);
      return httpRequest(localUrl, options, receive);
    },
  };
  try {
    await run(`https://127.0.0.1:${address.port}`, transport);
  } finally {
    for (const controller of controllers) controller.abort();
    await server.shutdown();
    await server.finished;
  }
};

/** The answer a server sends when it rejects an upload without reading the
 * whole body. The body is huge, so the client is still busy with it when the
 * write breaks: the failed write then lands inside the response processing,
 * which is the order that makes the polyfill's internal task reject. The
 * message inside stays short. */
const earlyAnswerBody = JSON.stringify({
  message: "invalid",
  pad: "x".repeat(8 * 1024 * 1024),
});

/** Upload the file at `path` to a server that answers with `handler`, and
 * expect the upload to reject with `match`. */
const expectUploadRejection = (
  path: string,
  handler: (request: Request) => Response | Promise<Response>,
  match: string | RegExp,
): Promise<void> =>
  withUploadServer(handler, (dbUrl, transport) =>
    expect(
      uploadTursoDatabaseFile(
        path,
        uploadCredentials(dbUrl),
        undefined,
        transport,
      ),
    ).rejects.toThrow(match),
  );

/** A request stub that swallows the piped file bytes. */
const fakeRequest = (): Writable =>
  new Writable({ write: (_chunk, _encoding, done) => done() });

/** A transport that plays a scripted sequence of events once the upload
 * starts, instead of talking to a real server. */
const scriptedTransport = (
  request: Writable,
  play: (receive: (response: IncomingMessage) => void) => void,
): DatabaseUploadTransport => ({
  request: (_url, _options, receive) => {
    queueMicrotask(() => play(receive));
    return request as unknown as ClientRequest;
  },
});

/** Upload a small file through a scripted transport and return the result. */
const uploadThroughScript = async (
  dir: string,
  request: Writable,
  play: (receive: (response: IncomingMessage) => void) => void,
): Promise<void> => {
  const path = join(dir, "database.sqlite");
  await Deno.writeTextFile(path, "sqlite bytes");
  await uploadTursoDatabaseFile(
    path,
    TEST_TURSO_CREDENTIALS,
    undefined,
    scriptedTransport(request, play),
  );
};

/** The server handler both early-answer tests share: read one chunk so the
 * socket stays alive until the answer is on the wire, then answer with the
 * padded rejection body while the write is still running. */
const earlyAnswerHandler = async (request: Request): Promise<Response> => {
  const body = request.body;
  assertExists(body, "Expected an upload body");
  const reader = body.getReader();
  await reader.read();
  return new Response(earlyAnswerBody, { status: 400 });
};

describe("Turso migration file", () => {
  test("accepts a complete SQLite file prepared for Turso", () =>
    withTempDir(async (dir) => {
      const path = join(dir, "database.sqlite");
      await createSqliteFile(path, [
        "PRAGMA page_size = 4096",
        "PRAGMA auto_vacuum = 0",
        "PRAGMA encoding = 'UTF-8'",
        "PRAGMA journal_mode = WAL",
      ]);

      await expect(
        verifyTursoUploadFile(path, createClient),
      ).resolves.toBeUndefined();
    }));

  test("rejects every SQLite setting Turso cannot upload", async () => {
    for (const example of [
      {
        message: "Database file must use WAL journal mode",
        pragmas: ["PRAGMA journal_mode = DELETE"],
      },
      {
        message: "Database file must use 4096-byte pages",
        pragmas: ["PRAGMA page_size = 1024", "PRAGMA journal_mode = WAL"],
      },
      {
        message: "Database file must have auto-vacuum disabled",
        pragmas: ["PRAGMA auto_vacuum = FULL", "PRAGMA journal_mode = WAL"],
      },
      {
        message: "Database file must use UTF-8 encoding",
        pragmas: ["PRAGMA encoding = 'UTF-16le'", "PRAGMA journal_mode = WAL"],
      },
    ]) {
      await withTempDir(async (dir) => {
        const path = join(dir, "database.sqlite");
        await createSqliteFile(path, example.pragmas);

        await expect(verifyTursoUploadFile(path, createClient)).rejects.toThrow(
          example.message,
        );
      });
    }
  });

  test("streams the full SQLite file with its exact byte length", () =>
    withTempDir(async (dir) => {
      const path = join(dir, "database.sqlite");
      const bytes = new Uint8Array(130_000).map((_, index) => index % 251);
      await Deno.writeFile(path, bytes);
      let uploaded: Uint8Array | undefined;
      let authorization: string | undefined;
      let contentLength: string | undefined;

      await withUploadServer(
        async (request) => {
          authorization = request.headers.get("authorization") ?? undefined;
          contentLength = request.headers.get("content-length") ?? undefined;
          uploaded = new Uint8Array(await request.arrayBuffer());
          return new Response();
        },
        (dbUrl, transport) =>
          uploadTursoDatabaseFile(
            path,
            uploadCredentials(dbUrl),
            new AbortController().signal,
            transport,
          ),
      );

      expect(authorization).toBe("Bearer database-token");
      expect(contentLength).toBe(String(bytes.byteLength));
      expect(uploaded).toEqual(bytes);
    }));

  test("rejects a snapshot path that is not a file", () =>
    withTempDir(async (dir) => {
      await expect(
        uploadTursoDatabaseFile(dir, TEST_TURSO_CREDENTIALS),
      ).rejects.toThrow(`Database snapshot is not a file: ${dir}`);
    }));

  test("reports an upload API failure", () =>
    withTempDir(async (dir) => {
      const path = join(dir, "database.sqlite");
      await Deno.writeTextFile(path, "sqlite bytes");

      await expectUploadRejection(
        path,
        async (request) => {
          // Read the whole upload first so the reply never races the body.
          await request.arrayBuffer();
          return new Response("invalid", { status: 400 });
        },
        "Upload database failed (400): invalid",
      );
    }));

  /** A server can answer before the whole body is sent, which breaks the write.
   * Both the answer and the write error are correct outcomes, so each is
   * scripted rather than raced. */
  test("prefers the server's answer over a later write error", () =>
    withTempDir(async (dir) => {
      const request = fakeRequest();
      const reply = Object.assign(new EventEmitter(), { statusCode: 400 });
      await expect(
        uploadThroughScript(dir, request, (receive) => {
          receive(reply as unknown as IncomingMessage);
          reply.emit("data", new TextEncoder().encode("invalid"));
          request.destroy(new Error("error writing a body to connection"));
          reply.emit("end");
        }),
      ).rejects.toThrow("Upload database failed (400): invalid");
    }));

  /** One upload can raise two errors — the write breaking, then the file
   * stopping because of it — and node throws an "error" nothing is listening
   * for, from a place no caller can catch. */
  test("survives a second error on the same request", () =>
    withTempDir(async (dir) => {
      const request = fakeRequest();
      await expect(
        uploadThroughScript(dir, request, () => {
          request.emit("error", new Error("write broke"));
        }),
      ).rejects.toThrow("write broke");

      expect(() =>
        request.emit("error", new Error("and the file stopped too")),
      ).not.toThrow();
    }));

  test("rejects a write error when no reply has arrived", () =>
    withTempDir(async (dir) => {
      const request = fakeRequest();
      await expect(
        uploadThroughScript(dir, request, () => {
          request.destroy(new Error("connection reset mid-upload"));
        }),
      ).rejects.toThrow("connection reset mid-upload");
    }));

  /** A real server can answer before the whole body is sent. The write then
   * breaks inside node:http's own internals, and the polyfill also rejects an
   * internal task that nobody awaits. The upload must still end as a normal
   * rejection, and the duplicate internal rejection must never escape as an
   * unhandled one. One read keeps the socket alive until the answer is on the
   * wire, and the padded body gives the client more to read while the write
   * breaks. That order makes the internal task fail on every run: with the
   * watch removed, this case ends the run the way issue #2314 reports. The
   * answer never finishes before the connection is gone, so the upload
   * reports the broken write. */
  test("survives a server that answers before the body is sent", () =>
    withTempDir(async (dir) => {
      const path = join(dir, "database.sqlite");
      // Big enough that the write cannot finish before the answer arrives.
      await Deno.writeFile(path, new Uint8Array(32_000_000));

      await expectUploadRejection(
        path,
        earlyAnswerHandler,
        "error writing a body to connection",
      );
    }));

  /** The harness's teardown aborts the still-streaming request through the
   * signal it plants, so the break surfaces as the request's own "error"
   * event. A teardown that breaks the socket instead leaves the polyfill's
   * write task rejecting with a bare "resource closed" string — an uncaught
   * error at an unknown location that failed two hosted runs. The listener
   * here only records: it never prevents the default, so a real escape
   * still fails this file. */
  test("the teardown aborts an in-flight upload with no stray rejections", () =>
    withTempDir(async (dir) => {
      const path = join(dir, "database.sqlite");
      await Deno.writeFile(path, new Uint8Array(32_000_000));

      const stray: string[] = [];
      const onRejection = (event: PromiseRejectionEvent) => {
        const reason = event.reason;
        if (
          !(
            reason instanceof TypeError &&
            reason.message === "Failed to fetch: request body stream errored"
          )
        ) {
          stray.push(reason instanceof Error ? reason.message : String(reason));
        }
      };
      globalThis.addEventListener("unhandledrejection", onRejection);
      try {
        for (let round = 0; round < 5; round += 1) {
          await withUploadServer(earlyAnswerHandler, (dbUrl, transport) =>
            expect(
              uploadTursoDatabaseFile(
                path,
                uploadCredentials(dbUrl),
                undefined,
                transport,
              ),
            ).rejects.toThrow("error writing a body to connection"),
          );
        }
        // One macrotask turn lets a rejection from the teardown's abort land
        // while the listener still records it. The polyfill dispatches
        // rejections on the platform's own schedule, so no deterministic
        // clock can drive it.
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 0);
        await promise;
      } finally {
        globalThis.removeEventListener("unhandledrejection", onRejection);
      }
      expect(stray).toEqual([]);
    }));

  // The rejection surfaces whenever the polyfill's own internal task ends, so
  // the watch cannot be timed to the upload — it stays up once an upload has
  // run, and earns that by only ever ignoring this one message.
  test("ignores the duplicate body-stream rejection and nothing else", () =>
    withTempDir(async (dir) => {
      const prevented = (reason: unknown): boolean => {
        const event = new PromiseRejectionEvent("unhandledrejection", {
          cancelable: true,
          promise: Promise.resolve(),
          reason,
        });
        globalThis.dispatchEvent(event);
        return event.defaultPrevented;
      };
      const defect = () =>
        new TypeError("Failed to fetch: request body stream errored");

      // Hold the upload open: the scripted transport never answers. The
      // watch is up by the time the transport runs, so wait for that.
      const started = Promise.withResolvers<void>();
      const request = fakeRequest();
      const upload = uploadThroughScript(dir, request, () => {
        started.resolve();
      });
      await started.promise;

      expect(prevented(defect())).toBe(true);
      expect(
        prevented(new Error("Failed to fetch: request body stream errored")),
      ).toBe(false);
      expect(prevented(new TypeError("some other failure"))).toBe(false);

      request.destroy(new Error("cut mid-upload"));
      await expect(upload).rejects.toThrow("cut mid-upload");
      // Still ignored after the upload settles: a late rejection is exactly
      // the one this watch exists for.
      expect(prevented(defect())).toBe(true);
      expect(prevented(new TypeError("some other failure"))).toBe(false);
    }));

  test("rejects an interrupted upload before opening the snapshot", () =>
    withTempDir(async (dir) => {
      const path = join(dir, "database.sqlite");
      await Deno.writeFile(path, new Uint8Array(130_000));
      const controller = new AbortController();
      controller.abort(new Error("interrupted"));

      await expect(
        uploadTursoDatabaseFile(
          path,
          TEST_TURSO_CREDENTIALS,
          controller.signal,
        ),
      ).rejects.toThrow("interrupted");

      await Deno.remove(path);
    }));

  test("rejects database upload URLs without TLS", () =>
    withTempDir(async (dir) => {
      const path = join(dir, "database.sqlite");
      await Deno.writeTextFile(path, "sqlite bytes");

      await expect(
        uploadTursoDatabaseFile(
          path,
          uploadCredentials("http://database.example.com"),
        ),
      ).rejects.toThrow("Turso database URL must use TLS");
    }));
});
