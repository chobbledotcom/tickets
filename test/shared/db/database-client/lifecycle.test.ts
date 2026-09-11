import type { Client } from "@libsql/client";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { emptyResultSet } from "#test-utils/db-helpers/result-set.ts";
import { hranaTestDatabase } from "#test-utils/hrana.ts";

describe("database client delegation", () => {
  test("delegates scripts through the shared limit", async () => {
    using remote = hranaTestDatabase();
    await remote.client.executeMultiple("SELECT 1;");
    expect(remote.requests).toEqual([["sequence", "close"]]);
    expect(remote.envelopes[0]!.requests[0]!.sql).toBe("SELECT 1;");
  });

  test("delegates migration batches through the shared limit", async () => {
    using remote = hranaTestDatabase();
    expect(await remote.client.migrate(["SELECT 2"])).toHaveLength(1);
    expect(remote.requests).toEqual([["batch", "close"]]);
    expect(
      remote.envelopes[0]!.requests[0]!.batch!.steps.map(
        (step) => step.stmt.sql,
      ),
    ).toContain("SELECT 2");
  });

  test("delegates interactive transactions through the shared limit", async () => {
    using remote = hranaTestDatabase();
    const transaction = await remote.client.transaction("write");
    expect((await transaction.execute("SELECT 3")).rows).toEqual([]);
    await transaction.commit();
    expect(transaction.closed).toBe(true);
    expect(remote.requests).toEqual([
      ["store_sql", "batch"],
      ["COMMIT", "close"],
    ]);
  });

  test("shares the configured concurrency limit between pipeline and native reads", async () => {
    using time = new FakeTime();
    const firstStarted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    using remote = hranaTestDatabase({
      config: { concurrency: 1 },
      select: async (sql) => {
        if (sql === "SELECT 1") {
          firstStarted.resolve();
          await release.promise;
        }
        return emptyResultSet();
      },
    });
    const first = remote.client.batch(["SELECT 1"], "write");
    await firstStarted.promise;
    const rest = Promise.all([
      remote.client.batch(["SELECT 2"], "write"),
      remote.client.execute("SELECT 3"),
    ]);
    try {
      await time.tickAsync(0);
      expect(remote.requests).toHaveLength(1);
    } finally {
      release.resolve();
      await Promise.all([first, rest]);
    }
    expect(remote.requests).toHaveLength(3);
  });

  for (const mode of [undefined, "read", "deferred"] as const) {
    test(`delegates SELECT batches in ${mode ?? "default"} mode`, async () => {
      const primaries: boolean[] = [];
      using remote = hranaTestDatabase({
        select: (_sql, _args, primary) => {
          primaries.push(primary);
          return Promise.resolve(emptyResultSet());
        },
      });
      const results = await remote.client.batch(["SELECT 1", "SELECT 2"], mode);
      expect(results).toHaveLength(2);
      expect(primaries).toEqual([false, false]);
      expect(remote.requests).toEqual([
        ["store_sql", "store_sql", "batch", "close"],
      ]);
      const begin = remote.envelopes[0]!.requests[2]!.batch!.steps[0]!.stmt.sql;
      expect(begin).toBe(
        mode === "read" ? "BEGIN TRANSACTION READONLY" : "BEGIN DEFERRED",
      );
    });
  }

  for (const statements of [
    ["INSERT INTO listings VALUES (1)"],
    ["SELECT 1", "UPDATE listings SET id = 2"],
    ["DELETE FROM listings", "SELECT 1"],
    ["WITH chosen AS (SELECT 1) INSERT INTO listings SELECT * FROM chosen"],
    [
      "WITH a AS (WITH b AS (SELECT 1) SELECT * FROM b) INSERT INTO listings SELECT * FROM a",
      "SELECT missing FROM listings",
    ],
    ["PRAGMA table_info(listings)"],
  ]) {
    test(`delegates native write batches: ${statements.join(", ")}`, async () => {
      using remote = hranaTestDatabase();
      expect(await remote.client.batch(statements, "write")).toHaveLength(
        statements.length,
      );
      expect(remote.requests).toEqual([
        [...statements.map(() => "store_sql"), "batch", "close"],
      ]);
      expect(
        remote.envelopes[0]!.requests.filter(
          (request) => request.type === "store_sql",
        ).map((request) => request.sql),
      ).toEqual(statements);
    });
  }

  test("keeps local reads and writes on the native SQLite client", async () => {
    using local = hranaTestDatabase({ config: { url: "file::memory:" } });
    expect(local.client.protocol).toBe("file");
    const results = await local.client.batch(
      [
        "CREATE TABLE listings (id INTEGER)",
        "INSERT INTO listings VALUES (2)",
        "SELECT id FROM listings",
      ],
      "write",
    );
    expect(results[1]!.rowsAffected).toBe(1);
    expect(results[2]!.rows[0]!.id).toBe(2);
    expect(
      (await local.client.batch(["SELECT id FROM listings"], "write"))[0]!
        .rows[0]!.id,
    ).toBe(2);
    expect(local.requests).toEqual([]);
    local.client.close();
    expect(local.client.closed).toBe(true);
  });

  test("delegates execute with its native receiver", async () => {
    using remote = hranaTestDatabase();
    const execute = remote.client.execute;
    expect((await execute("SELECT 1")).toJSON().rows).toEqual([]);
    expect(remote.requests).toEqual([["SELECT 1", "close"]]);
    expect(remote.client.protocol).toBe("http");
    expect(remote.client.closed).toBe(false);
  });
});

describe("primary read stream lifecycle", () => {
  test("uses a fresh closed stream for each repeated call", async () => {
    using remote = hranaTestDatabase();
    const statements: Parameters<Client["batch"]>[0] = [
      "WITH chosen AS (SELECT 1) SELECT * FROM chosen",
    ];
    for (let call = 0; call < 3; call++)
      await remote.client.batch(statements, "write");
    expect(remote.requests).toEqual(
      Array.from({ length: 3 }, () => [
        "BEGIN IMMEDIATE",
        "batch",
        "COMMIT",
        "close",
      ]),
    );
    expect(remote.envelopes.map((envelope) => envelope.baton)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  test("closes an empty primary read batch in one request", async () => {
    using remote = hranaTestDatabase();
    expect(await remote.client.batch([], "write")).toEqual([]);
    expect(remote.requests).toEqual([
      ["BEGIN IMMEDIATE", "batch", "COMMIT", "close"],
    ]);
  });

  for (const opened of [false, true]) {
    test(`close refuses new work with ${opened ? "an active" : "no"} pipeline client`, async () => {
      using remote = hranaTestDatabase();
      if (opened) await remote.client.batch(["SELECT 1"], "write");
      remote.client.close();
      remote.client.close();
      await expect(
        remote.client.batch(["SELECT 2"], "write"),
      ).rejects.toMatchObject({
        code: "CLIENT_CLOSED",
        message: expect.stringContaining("The database client is closed"),
      });
      await expect(remote.client.execute("SELECT 3")).rejects.toMatchObject({
        code: "UNKNOWN",
        message: expect.stringContaining("Client is closed"),
      });
      expect(remote.requests).toHaveLength(Number(opened));
      expect(remote.client.closed).toBe(true);
    });
  }

  test("reconnect creates a usable pipeline after close", async () => {
    using remote = hranaTestDatabase();
    remote.client.reconnect();
    await remote.client.batch(["SELECT 1"], "write");
    remote.client.reconnect();
    await remote.client.batch(["SELECT 2"], "write");
    remote.client.close();
    remote.client.reconnect();
    expect(await remote.client.batch(["SELECT 3"], "write")).toHaveLength(1);
    expect(remote.requests).toEqual(
      Array.from({ length: 3 }, () => [
        "BEGIN IMMEDIATE",
        "batch",
        "COMMIT",
        "close",
      ]),
    );
    expect(remote.client.closed).toBe(false);
  });

  for (const secondFails of [false, true]) {
    test(`concurrent streams stay independent when the second call ${secondFails ? "fails" : "succeeds"}`, async () => {
      const firstStarted = Promise.withResolvers<void>();
      const releaseFirst = Promise.withResolvers<void>();
      using remote = hranaTestDatabase({
        select: async (sql) => {
          if (sql === "SELECT 2" && secondFails)
            throw new Error("Second stream failed");
          if (sql === "SELECT 1") {
            firstStarted.resolve();
            await releaseFirst.promise;
          }
          return {
            ...emptyResultSet(),
            columns: ["sql"],
            columnTypes: ["TEXT"],
            rows: [{ 0: sql, length: 1, sql }],
          };
        },
      });
      const first = remote.client.batch(["SELECT 1"], "write");
      try {
        await firstStarted.promise;
        const second = remote.client.batch(["SELECT 2"], "write");
        if (secondFails) {
          await expect(second).rejects.toMatchObject({
            code: "SQLITE_ERROR",
            statementIndex: 0,
          });
        } else {
          expect((await second)[0]!.rows[0]!.sql).toBe("SELECT 2");
        }
      } finally {
        releaseFirst.resolve();
      }
      expect((await first)[0]!.rows[0]!.sql).toBe("SELECT 1");
      expect(remote.requests).toEqual(
        Array.from({ length: 2 }, () => [
          "BEGIN IMMEDIATE",
          "batch",
          "COMMIT",
          "close",
        ]),
      );
      expect(remote.envelopes.map((envelope) => envelope.baton)).toEqual([
        undefined,
        undefined,
      ]);
    });
  }
});
