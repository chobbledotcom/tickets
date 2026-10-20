// test-groups: run-alone

import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { createClient } from "@libsql/client";
import { expect } from "@std/expect";
import { join, toFileUrl } from "@std/path";
import { describe, it as test } from "@std/testing/bdd";
import {
  uploadTursoDatabaseFile,
  verifyTursoUploadFile,
} from "#scripts/turso-migration-file.ts";
import { withTempDir } from "#test-utils/files.ts";
import { TEST_TURSO_CREDENTIALS } from "#test-utils/turso-api.ts";
import {
  earlyAnswerHandler,
  expectUploadRejection,
  fakeRequest,
  uploadCredentials,
  uploadThroughScript,
  withUploadServer,
} from "./turso-upload-harness.ts";

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
