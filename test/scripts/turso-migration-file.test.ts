// test-groups: run-alone

import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import { Writable } from "node:stream";
import { createClient } from "@libsql/client";
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
  const transport: DatabaseUploadTransport = {
    request: (url, options, receive) => {
      expect(url.protocol).toBe("https:");
      const localUrl = new URL(url);
      localUrl.protocol = "http:";
      return httpRequest(localUrl, options, receive);
    },
  };
  try {
    await run(`https://127.0.0.1:${address.port}`, transport);
  } finally {
    await server.shutdown();
    await server.finished;
  }
};

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
const uploadThroughScript = (
  dir: string,
  request: Writable,
  play: (receive: (response: IncomingMessage) => void) => void,
): Promise<void> =>
  Deno.writeTextFile(join(dir, "database.sqlite"), "sqlite bytes").then(() =>
    uploadTursoDatabaseFile(
      join(dir, "database.sqlite"),
      TEST_TURSO_CREDENTIALS,
      undefined,
      scriptedTransport(request, play),
    ),
  );

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

      await withUploadServer(
        async (request) => {
          // Read the whole upload first so the reply never races the body.
          await request.arrayBuffer();
          return new Response("invalid", { status: 400 });
        },
        async (dbUrl, transport) => {
          await expect(
            uploadTursoDatabaseFile(
              path,
              uploadCredentials(dbUrl),
              undefined,
              transport,
            ),
          ).rejects.toThrow("Upload database failed (400): invalid");
        },
      );
    }));

  // Regression: a server that answers before the whole body is sent breaks
  // the upload write. The caller must get the server's answer or the write
  // error as a normal rejection — never a process-killing internal error.
  test("still rejects when the server replies before the upload finishes", () =>
    withTempDir(async (dir) => {
      const path = join(dir, "database.sqlite");
      // Big enough that the client cannot finish writing before the 400 lands.
      await Deno.writeFile(path, new Uint8Array(8_000_000));

      await withUploadServer(
        () => new Response("invalid", { status: 400 }),
        async (dbUrl, transport) => {
          await expect(
            uploadTursoDatabaseFile(
              path,
              uploadCredentials(dbUrl),
              undefined,
              transport,
            ),
          ).rejects.toThrow(
            /Upload database failed \(400\): invalid|error writing a body to connection/,
          );
        },
      );
    }));

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

  test("rejects a write error when no reply has arrived", () =>
    withTempDir(async (dir) => {
      const request = fakeRequest();
      await expect(
        uploadThroughScript(dir, request, () => {
          request.destroy(new Error("connection reset mid-upload"));
        }),
      ).rejects.toThrow("connection reset mid-upload");
    }));

  test("ignores only the duplicate body-stream rejection from node:http", () =>
    withTempDir(async (dir) => {
      // Any upload installs the safety listener; this one fails fast.
      const request = fakeRequest();
      await expect(
        uploadThroughScript(dir, request, () => {
          request.destroy(new Error("install trigger"));
        }),
      ).rejects.toThrow("install trigger");

      const prevented = (reason: unknown): boolean => {
        const event = new PromiseRejectionEvent("unhandledrejection", {
          cancelable: true,
          promise: Promise.resolve(),
          reason,
        });
        globalThis.dispatchEvent(event);
        return event.defaultPrevented;
      };
      expect(
        prevented(
          new TypeError("Failed to fetch: request body stream errored"),
        ),
      ).toBe(true);
      expect(
        prevented(new Error("Failed to fetch: request body stream errored")),
      ).toBe(false);
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
