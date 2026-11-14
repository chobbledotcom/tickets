import type { ResultSet } from "@libsql/client";
import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import {
  execute,
  executeBatch,
  executeBatchWithoutCacheInvalidation,
  rowExists,
  withTransaction,
} from "#db/client.ts";
import { type SqlStatement, sql } from "#db/sql.ts";
import {
  registerTableInvalidation,
  type Unregister,
} from "#shared/cache-registry.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { emptyResultSet } from "#test-utils/db-helpers/result-set.ts";
import { stubTransaction } from "#test-utils/db-helpers/stub-transaction.ts";

/**
 * Column-driven cache invalidation: after every write, the db client reads the
 * SET columns of an UPDATE, so a column-gated registration fires only when a
 * gated column is actually assigned — while INSERT / DELETE / REPLACE always
 * fire. These tests pin `invalidateForSql` (src/shared/db/client.ts) through
 * the public execute() + registry API.
 */
describeWithEnv("db > client write invalidation", { db: true }, () => {
  // Each test's registration is removed afterwards; the registry is shared
  // module state, so a leftover counter would keep firing for later tests.
  const cleanups: Unregister[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  /** Register an invalidation on `settings` and count its firings. */
  const countFirings = (whenColumns?: readonly string[]): { fired: number } => {
    const counter = { fired: 0 };
    cleanups.push(
      registerTableInvalidation(
        ["settings"],
        () => {
          counter.fired++;
        },
        { whenColumns },
      ),
    );
    return counter;
  };

  const settingsInsert = (key: string, value: string): SqlStatement =>
    sql`INSERT INTO settings (key, value) VALUES (${key}, ${value})`;

  const updateValue = (key: string): SqlStatement =>
    sql`UPDATE settings SET value = ${"new"} WHERE key = ${key}`;

  /** Run `write` under an invalidator gated on `gate`, and name how often the
   * invalidator fires. */
  const firingsFor = async (
    write: () => Promise<unknown>,
    gate?: readonly string[],
  ): Promise<number> => {
    const counter = countFirings(gate);
    await write();
    return counter.fired;
  };

  /**
   * One statement per gate rule, each measured on its own row. An INSERT always
   * fires; an UPDATE fires only when its SET assigns a gated column, so a
   * misread verb or a dropped SET column list would show up as the wrong count;
   * a DELETE fires whatever its gate, because a row leaving the table shifts
   * aggregates; and a CTE-led UPDATE fires by the columns its own SET names,
   * because the CTE prefix must be stripped before classification.
   */
  const writeCases: readonly {
    name: string;
    key: string;
    gate?: readonly string[];
    seed: boolean;
    write: (key: string) => SqlStatement;
    fired: number;
  }[] = [
    {
      fired: 1,
      key: "inv_insert",
      name: "INSERT fires an unconditional invalidator",
      seed: false,
      write: (key) => settingsInsert(key, "seed"),
    },
    {
      fired: 1,
      gate: ["value"],
      key: "inv_update_hit",
      name: "UPDATE assigning a gated column fires the gated invalidator",
      seed: true,
      write: updateValue,
    },
    {
      fired: 0,
      gate: ["some_other_column"],
      key: "inv_update_miss",
      name: "UPDATE assigning only ungated columns skips the gated invalidator",
      seed: true,
      write: updateValue,
    },
    {
      fired: 1,
      gate: ["some_other_column"],
      key: "inv_delete",
      name: "DELETE fires a gated invalidator regardless of its column gate",
      seed: true,
      write: (key) => sql`DELETE FROM settings WHERE key = ${key}`,
    },
    {
      fired: 1,
      gate: ["value"],
      key: "inv_cte",
      name: "a CTE-led UPDATE invalidates by its own SET columns",
      seed: true,
      write: (key) =>
        sql`WITH ignored AS (SELECT 1) UPDATE settings SET value = ${"new"} WHERE key = ${key}`,
    },
  ];

  for (const { name, key, gate, seed, write, fired } of writeCases) {
    test(name, async () => {
      if (seed) await execute(settingsInsert(key, "seed"));
      expect(await firingsFor(() => execute(write(key)), gate)).toBe(fired);
    });
  }

  test("a committed batch invalidates for each written statement", async () => {
    expect(
      await firingsFor(() =>
        executeBatch([
          settingsInsert("inv_batch_1", "a"),
          settingsInsert("inv_batch_2", "b"),
        ]),
      ),
    ).toBe(2);
  });

  test("executeBatchWithoutCacheInvalidation writes without firing invalidators", async () => {
    expect(
      await firingsFor(() =>
        executeBatchWithoutCacheInvalidation([
          settingsInsert("inv_marker", "seed"),
        ]),
      ),
    ).toBe(0);
    // The write still lands — only the invalidation is skipped.
    expect(
      await rowExists(
        sql`SELECT 1 FROM settings WHERE key = ${"inv_marker"} LIMIT 1`,
      ),
    ).toBe(true);
  });

  /**
   * A commit that suspends until the test resolves it, plus a promise that
   * resolves the moment `commit` is called — so the test can prove invalidation
   * is held between the write landing and commit resolving. Shared by the two
   * commit-gated invalidation tests below.
   */
  const pendingCommit = () => {
    let resolveCommit!: () => void;
    let signalCommitStarted!: () => void;
    const commitPromise = new Promise<void>((resolve) => {
      resolveCommit = resolve;
    });
    const commitStarted = new Promise<void>((resolve) => {
      signalCommitStarted = resolve;
    });
    return {
      commit: () => {
        signalCommitStarted();
        return commitPromise;
      },
      commitStarted,
      resolveCommit,
    };
  };

  test("a single statement inside withTransaction invalidates only after commit", async () => {
    // Suspend commit and wait until it is actually invoked: invalidation must
    // not fire while the transaction is still open, only once commit resolves.
    const pending = pendingCommit();
    using _txStub = stubTransaction({
      commit: pending.commit,
      execute: () => Promise.resolve(emptyResultSet()),
      rollback: () => Promise.resolve(),
    });
    const counter = countFirings();
    const done = withTransaction(async (tx) => {
      await tx.execute(settingsInsert("inv_tx", "seed"));
    });
    // Wait until commit has been called — by then the write has run and any
    // premature invalidation would have fired.
    await pending.commitStarted;
    expect(counter.fired).toBe(0);
    pending.resolveCommit();
    await done;
    expect(counter.fired).toBe(1);
  });

  test("a batch inside withTransaction invalidates only after commit", async () => {
    const pending = pendingCommit();
    using _txStub = stubTransaction({
      batch: () => Promise.resolve([emptyResultSet()] as ResultSet[]),
      commit: pending.commit,
      rollback: () => Promise.resolve(),
    });
    const counter = countFirings();
    const done = withTransaction(async (tx) => {
      await tx.batch([settingsInsert("inv_tx_batch", "seed")]);
    });
    await pending.commitStarted;
    expect(counter.fired).toBe(0);
    pending.resolveCommit();
    await done;
    expect(counter.fired).toBe(1);
  });
});
