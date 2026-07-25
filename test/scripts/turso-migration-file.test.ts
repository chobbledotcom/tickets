import { Buffer } from "node:buffer";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
// test-groups: run-alone
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
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (dbUrl: string) => Promise<void>,
): Promise<void> => {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Upload test server has no TCP address");
  }
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
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
        async (request, response) => {
          authorization = request.headers.authorization;
          contentLength = request.headers["content-length"];
          const chunks = await Array.fromAsync(request);
          uploaded = new Uint8Array(Buffer.concat(chunks));
          response.end();
        },
        (dbUrl) =>
          uploadTursoDatabaseFile(
            path,
            uploadCredentials(dbUrl),
            new AbortController().signal,
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
        (_request, response) => {
          response.writeHead(400);
          response.end("invalid");
        },
        async (dbUrl) => {
          await expect(
            uploadTursoDatabaseFile(path, uploadCredentials(dbUrl)),
          ).rejects.toThrow("Upload database failed (400): invalid");
        },
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

  test("starts a TLS connection for a libsql database URL", () =>
    withTempDir(async (dir) => {
      const path = join(dir, "database.sqlite");
      await Deno.writeTextFile(path, "sqlite bytes");
      const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
      const address = listener.addr;
      const upload = uploadTursoDatabaseFile(path, {
        ...TEST_TURSO_CREDENTIALS,
        dbUrl: `libsql://127.0.0.1:${address.port}`,
      });

      try {
        const connection = await listener.accept();
        const firstByte = new Uint8Array(1);
        await connection.read(firstByte);
        connection.close();
        await expect(upload).rejects.toThrow();
        expect(firstByte[0]).toBe(22);
      } finally {
        listener.close();
      }
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
