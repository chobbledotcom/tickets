import { createClient } from "@libsql/client";
import { expect } from "@std/expect";
import { join, toFileUrl } from "@std/path";
import { describe, it as test } from "@std/testing/bdd";
import {
  uploadTursoDatabaseFile,
  verifyTursoUploadFile,
} from "#scripts/turso-migration-file.ts";
import { errorResult, okResult } from "#shared/result.ts";
import { withTempDir } from "#test-utils/files.ts";
import { fakeTursoApi, TEST_TURSO_CREDENTIALS } from "#test-utils/turso-api.ts";

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
      let uploadedLength: number | undefined;
      const api = fakeTursoApi({
        uploadDatabase: async (credentials, body, contentLength) => {
          expect(credentials).toEqual(TEST_TURSO_CREDENTIALS);
          uploadedLength = contentLength;
          uploaded = new Uint8Array(await new Response(body).arrayBuffer());
          return okResult(undefined);
        },
      });

      await uploadTursoDatabaseFile(path, api, TEST_TURSO_CREDENTIALS);

      expect(uploadedLength).toBe(bytes.byteLength);
      expect(uploaded).toEqual(bytes);
    }));

  test("rejects a snapshot path that is not a file", () =>
    withTempDir(async (dir) => {
      const api = fakeTursoApi();
      await expect(
        uploadTursoDatabaseFile(dir, api, TEST_TURSO_CREDENTIALS),
      ).rejects.toThrow(`Database snapshot is not a file: ${dir}`);
    }));

  test("reports an upload API failure", () =>
    withTempDir(async (dir) => {
      const path = join(dir, "database.sqlite");
      await Deno.writeTextFile(path, "sqlite bytes");
      const api = fakeTursoApi({
        uploadDatabase: () =>
          Promise.resolve(errorResult("Upload database failed (400): invalid")),
      });

      await expect(
        uploadTursoDatabaseFile(path, api, TEST_TURSO_CREDENTIALS),
      ).rejects.toThrow("Upload database failed (400): invalid");
    }));

  test("keeps the snapshot after a successful upload", () =>
    withTempDir(async (dir) => {
      const path = join(dir, "database.sqlite");
      await Deno.writeTextFile(path, "sqlite bytes");

      await uploadTursoDatabaseFile(
        path,
        fakeTursoApi(),
        TEST_TURSO_CREDENTIALS,
      );

      expect(await Deno.readTextFile(path)).toBe("sqlite bytes");
    }));

  test("closes the file when upload throws", () =>
    withTempDir(async (dir) => {
      const path = join(dir, "database.sqlite");
      await Deno.writeTextFile(path, "sqlite bytes");
      const api = fakeTursoApi({
        uploadDatabase: () => Promise.reject(new Error("network failed")),
      });

      await expect(
        uploadTursoDatabaseFile(path, api, TEST_TURSO_CREDENTIALS),
      ).rejects.toThrow("network failed");
      await Deno.remove(path);
      expect(await Array.fromAsync(Deno.readDir(dir))).toEqual([]);
    }));
});
