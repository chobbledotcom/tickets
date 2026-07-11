import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, insert, queryOne } from "#shared/db/client.ts";
import {
  allNamesById,
  columnMapByIds,
  mapByIds,
  nameMapByIds,
  rowsByIds,
  swapSortOrder,
} from "#shared/db/query.ts";
import { describeWithEnv } from "#test-utils/db.ts";

/** Insert one attendee_statuses row with a plaintext name (the query helpers
 * are decryption-agnostic, so direct rows keep these tests self-contained). */
const insertStatus = async (
  name: string,
  sortOrder: number,
): Promise<number> => {
  const stmt = insert("attendee_statuses", {
    name,
    reservation_amount: "0",
    sort_order: sortOrder,
  });
  return Number((await execute(stmt.sql, stmt.args)).lastInsertRowid);
};

const sortOrderOf = async (id: number): Promise<number> => {
  const row = await queryOne<{ sort_order: number }>(
    "SELECT sort_order FROM attendee_statuses WHERE id = ?",
    [id],
  );
  return row!.sort_order;
};

/** Identity "decryptor" for the plaintext names inserted above. */
const plaintextName = (raw: string): Promise<string> => Promise.resolve(raw);

describeWithEnv("db > query > swapSortOrder", { db: true }, () => {
  test("swaps the two rows' sort_order values", async () => {
    const low = await insertStatus("Low", 10);
    const high = await insertStatus("High", 20);

    await swapSortOrder("attendee_statuses", low, high);

    expect(await sortOrderOf(low)).toBe(20);
    expect(await sortOrderOf(high)).toBe(10);
  });

  test("swapping back restores the original order", async () => {
    const low = await insertStatus("Low", 10);
    const high = await insertStatus("High", 20);

    await swapSortOrder("attendee_statuses", low, high);
    await swapSortOrder("attendee_statuses", low, high);

    expect(await sortOrderOf(low)).toBe(10);
    expect(await sortOrderOf(high)).toBe(20);
  });

  test("is a no-op when one of the ids is missing", async () => {
    // A stale reorder click racing a delete: nothing may change.
    const survivor = await insertStatus("Survivor", 10);

    await swapSortOrder("attendee_statuses", survivor, 999_999);

    expect(await sortOrderOf(survivor)).toBe(10);
  });
});

describeWithEnv("db > query > id-keyed lookups", { db: true }, () => {
  test("rowsByIds returns an empty array for empty ids without building a query", async () => {
    // The builder must not run at all on the empty short-circuit — a thrown
    // builder proves no SQL was even constructed.
    const rows = await rowsByIds([], () => {
      throw new Error("buildSql must not be called for empty ids");
    });
    expect(rows).toEqual([]);
  });

  test("rowsByIds fetches exactly the requested rows", async () => {
    const alpha = await insertStatus("Alpha", 1);
    const beta = await insertStatus("Beta", 2);
    await insertStatus("Gamma", 3); // not requested

    const rows = await rowsByIds<{ id: number; name: string }>(
      [alpha, beta],
      (placeholders) =>
        `SELECT status.id, status.name FROM attendee_statuses AS status WHERE status.id IN (${placeholders}) ORDER BY status.id`,
    );

    expect(rows).toEqual([
      { id: alpha, name: "Alpha" },
      { id: beta, name: "Beta" },
    ]);
  });

  test("mapByIds returns an empty map for empty ids without building a query", async () => {
    // The builder must not run at all on the empty short-circuit — a thrown
    // builder proves no SQL was even constructed.
    const map = await mapByIds<{ id: number; sort_order: number }>(
      [],
      () => {
        throw new Error("buildSql must not be called for empty ids");
      },
      (row) => [row.id, row.sort_order],
    );
    expect(map).toEqual(new Map());
  });

  test("mapByIds fetches and maps exactly the requested rows", async () => {
    const alpha = await insertStatus("Alpha", 1);
    const beta = await insertStatus("Beta", 2);
    await insertStatus("Gamma", 3); // not requested

    const map = await mapByIds<{ id: number; sort_order: number }>(
      [alpha, beta],
      (placeholders) =>
        `SELECT status.id, status.sort_order FROM attendee_statuses AS status WHERE status.id IN (${placeholders})`,
      (row) => [row.id, row.sort_order],
    );

    expect(map).toEqual(
      new Map([
        [alpha, 1],
        [beta, 2],
      ]),
    );
  });

  test("columnMapByIds maps id → column for the requested ids only", async () => {
    const alpha = await insertStatus("Alpha", 7);
    const beta = await insertStatus("Beta", 9);
    const gamma = await insertStatus("Gamma", 11);

    const map = await columnMapByIds(
      "attendee_statuses",
      "status",
      "sort_order",
      [alpha, gamma],
    );

    expect(map).toEqual(
      new Map([
        [alpha, 7],
        [gamma, 11],
      ]),
    );
    expect(map.has(beta)).toBe(false);
  });

  test("columnMapByIds returns an empty map for empty ids", async () => {
    expect(
      await columnMapByIds("attendee_statuses", "status", "sort_order", []),
    ).toEqual(new Map());
  });
});

describeWithEnv("db > query > name maps", { db: true }, () => {
  test("nameMapByIds decrypts only the requested rows' names", async () => {
    const alpha = await insertStatus("Alpha", 1);
    const beta = await insertStatus("Beta", 2);
    await insertStatus("Gamma", 3); // not requested

    const map = await nameMapByIds(
      "attendee_statuses",
      "status",
      "name",
      [alpha, beta],
      plaintextName,
    );

    expect(map).toEqual(
      new Map([
        [alpha, "Alpha"],
        [beta, "Beta"],
      ]),
    );
  });

  test("nameMapByIds returns an empty map for empty ids", async () => {
    expect(
      await nameMapByIds(
        "attendee_statuses",
        "status",
        "name",
        [],
        plaintextName,
      ),
    ).toEqual(new Map());
  });

  test("allNamesById maps every row, ordered by ascending id", async () => {
    const zeta = await insertStatus("Zeta", 5);
    const alpha = await insertStatus("Alpha", 4);

    const map = await allNamesById(
      "attendee_statuses",
      "status",
      "name",
      plaintextName,
    );

    expect(map.get(zeta)).toBe("Zeta");
    expect(map.get(alpha)).toBe("Alpha");
    // Ordered by id, not by name or sort_order: Map preserves query order.
    const ids = [...map.keys()];
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(ids.indexOf(zeta)).toBeLessThan(ids.indexOf(alpha));
  });
});
