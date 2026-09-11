import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { createDatabaseClient } from "#db/database-client.ts";
import { emptyResultSet } from "#test-utils/db-helpers/result-set.ts";
import { hranaTestDatabase, hranaTestFetch } from "#test-utils/hrana.ts";

describe("primary read pipeline", () => {
  test("uses the configured HTTP URL, credentials, and encryption header", async () => {
    const requests: {
      url: string;
      method: string;
      headers: Record<string, string>;
    }[] = [];
    const remote = hranaTestFetch();
    using database = hranaTestDatabase({
      config: {
        authToken: "test-token",
        fetch: (request: Request) => {
          requests.push({
            headers: Object.fromEntries(request.headers.entries()),
            method: request.method,
            url: request.url,
          });
          return remote.fetch(request);
        },
        remoteEncryptionKey: "test-encryption-key",
        url: "libsql://pipeline.test:8443/tenant/",
      },
    });
    await database.client.batch(["SELECT 1"], "write");
    expect(requests).toEqual([
      {
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
          "x-turso-encryption-key": "test-encryption-key",
        },
        method: "POST",
        url: "https://pipeline.test:8443/tenant/v2/pipeline",
      },
    ]);
  });

  test("reads the primary in one HTTP request even when complete batches see a stale replica", async () => {
    const remote = hranaTestFetch((_sql, _args, primary) =>
      Promise.resolve({
        ...emptyResultSet(),
        columns: ["id"],
        columnTypes: ["INTEGER"],
        rows: primary ? [{ 0: 2, id: 2, length: 1 }] : [],
      }),
    );
    const client = createDatabaseClient({
      fetch: remote.fetch,
      url: "libsql://pipeline.test",
    });
    try {
      const [result] = await client.batch(
        [{ args: [2], sql: "SELECT id FROM listings WHERE id = ?" }],
        "write",
      );
      expect(result!.rows.map((row) => row.id)).toEqual([2]);
      expect(remote.requests).toEqual([
        ["BEGIN IMMEDIATE", "batch", "COMMIT", "close"],
      ]);
    } finally {
      client.close();
    }
  });
});
