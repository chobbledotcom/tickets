import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { readDatabaseConfigOrError } from "#shared/db/database-config.ts";
import { TEST_ENCRYPTION_KEY } from "#test-utils/internal.ts";

const env =
  (
    overrides: Record<string, string | undefined> = {},
  ): ((key: string) => string | undefined) =>
  (key) =>
    overrides[key];

describe("readDatabaseConfigOrError", () => {
  test("returns the DB_URL when every requirement holds", () => {
    const result = readDatabaseConfigOrError(
      env({
        DB_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
        DB_URL: "file:./local.db",
      }),
      "verify",
    );
    expect(result).toEqual({ dbUrl: "file:./local.db", ok: true });
  });

  test("accepts a remote database when DB_TOKEN is set", () => {
    const result = readDatabaseConfigOrError(
      env({
        DB_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
        DB_TOKEN: "secret",
        DB_URL: "libsql://tickets.example.com",
      }),
      "restore",
    );
    expect(result).toEqual({ dbUrl: "libsql://tickets.example.com", ok: true });
  });

  test("requires DB_URL", () => {
    const result = readDatabaseConfigOrError(
      env({ DB_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY }),
      "verify",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toBe("DB_URL is required in .env.");
  });

  test("refuses :memory: and names the action", () => {
    const result = readDatabaseConfigOrError(
      env({
        DB_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
        DB_URL: ":memory:",
      }),
      "verify",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe(
        "DB_URL cannot be :memory: for a verify. Set it to the target database in .env.",
      );
    }
  });

  test("requires DB_TOKEN for a remote database", () => {
    const result = readDatabaseConfigOrError(
      env({
        DB_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
        DB_URL: "libsql://tickets.example.com",
      }),
      "restore",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe(
        "DB_TOKEN is required in .env for a remote database.",
      );
    }
  });

  test("requires DB_ENCRYPTION_KEY", () => {
    const result = readDatabaseConfigOrError(
      env({ DB_URL: "file:./local.db" }),
      "verify",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe("DB_ENCRYPTION_KEY is required in .env.");
    }
  });

  test("rejects an encryption key that is not 32 bytes", () => {
    const result = readDatabaseConfigOrError(
      env({ DB_ENCRYPTION_KEY: "c2hvcnQ=", DB_URL: "file:./local.db" }),
      "verify",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("32 bytes");
    }
  });
});
