import { expect } from "@std/expect";
import { join } from "@std/path";
import { describe, it as test } from "@std/testing/bdd";
import {
  parseSnapshotArgs,
  readSnapshotRequest,
  readSnapshotRequestFromEnvFile,
  SNAPSHOT_USAGE,
} from "#scripts/database-snapshot-lib.ts";
import { withEnv } from "#test-utils/env.ts";
import { withTempDir } from "#test-utils/files.ts";

const envReader =
  (values: Record<string, string | undefined>) =>
  (key: string): string | undefined =>
    values[key];

describe("database snapshot options", () => {
  test("accepts one output path", () => {
    expect(parseSnapshotArgs(["--out", "backups/site.sqlite"])).toEqual({
      outputPath: "backups/site.sqlite",
    });
  });

  test("returns help without an output path", () => {
    expect(parseSnapshotArgs(["--help"])).toBeNull();
    expect(parseSnapshotArgs(["-h"])).toBeNull();
  });

  test("rejects missing, blank, duplicate, and extra output arguments", () => {
    const invalidArguments = [
      [],
      ["--out"],
      ["--out", " "],
      ["--out", "one.sqlite", "--out", "two.sqlite"],
      ["--out", "site.sqlite", "extra"],
      ["--out", "site.sqlite", "--unknown"],
      ["--help", "--out", "site.sqlite"],
    ];

    for (const args of invalidArguments) {
      expect(() => parseSnapshotArgs(args)).toThrow(SNAPSHOT_USAGE);
    }
  });

  test("reads remote database credentials", () => {
    using _env = withEnv({
      DB_TOKEN: "secret-token",
      DB_URL: "libsql://site.example.com",
    });
    expect(readSnapshotRequest({ outputPath: "site.sqlite" })).toEqual({
      dbToken: "secret-token",
      dbUrl: "libsql://site.example.com",
      outputPath: "site.sqlite",
    });
  });

  test("prefers database credentials from .env over shell values", () =>
    withTempDir(async (dir) => {
      const envPath = join(dir, ".env");
      await Deno.writeTextFile(
        envPath,
        'DB_URL="libsql://file.example.com"\nDB_TOKEN="file-token"\n',
      );

      await expect(
        readSnapshotRequestFromEnvFile(
          { outputPath: "site.sqlite" },
          envPath,
          envReader({ DB_TOKEN: "shell-token", DB_URL: ":memory:" }),
        ),
      ).resolves.toEqual({
        dbToken: "file-token",
        dbUrl: "libsql://file.example.com",
        outputPath: "site.sqlite",
      });
    }));

  test("uses shell credentials when .env is absent", () =>
    withTempDir(
      async (dir) =>
        await expect(
          readSnapshotRequestFromEnvFile(
            { outputPath: "site.sqlite" },
            join(dir, ".env"),
            envReader({
              DB_TOKEN: "shell-token",
              DB_URL: "libsql://shell.example.com",
            }),
          ),
        ).resolves.toEqual({
          dbToken: "shell-token",
          dbUrl: "libsql://shell.example.com",
          outputPath: "site.sqlite",
        }),
    ));

  test("rejects missing database credentials", () => {
    expect(() =>
      readSnapshotRequest(
        { outputPath: "site.sqlite" },
        envReader({ DB_TOKEN: "token" }),
      ),
    ).toThrow("DB_URL environment variable is required");
    expect(() =>
      readSnapshotRequest(
        { outputPath: "site.sqlite" },
        envReader({ DB_URL: "libsql://site.example.com" }),
      ),
    ).toThrow("DB_TOKEN environment variable is required");
    expect(() =>
      readSnapshotRequest(
        { outputPath: "site.sqlite" },
        envReader({ DB_TOKEN: " ", DB_URL: "libsql://site.example.com" }),
      ),
    ).toThrow("DB_TOKEN environment variable is required");
  });

  test("rejects local and malformed database URLs", () => {
    for (const dbUrl of [":memory:", "file:site.sqlite", "not a URL"]) {
      expect(() =>
        readSnapshotRequest(
          { outputPath: "site.sqlite" },
          envReader({ DB_TOKEN: "token", DB_URL: dbUrl }),
        ),
      ).toThrow("DB_URL must be a remote libSQL or HTTP URL");
    }
  });

  test("accepts each supported remote database protocol", () => {
    for (const dbUrl of [
      "libsql://site.example.com",
      "https://site.example.com",
      "http://localhost:8080",
    ]) {
      expect(
        readSnapshotRequest(
          { outputPath: "site.sqlite" },
          envReader({ DB_TOKEN: "token", DB_URL: dbUrl }),
        ).dbUrl,
      ).toBe(dbUrl);
    }
  });
});
