/** The sealed order of a card checkout: only the provider's copy of the token
 * opens it, and a dump alone reads nothing. Its prune is checked in
 * test/shared/db/prune/checkout-bundles.test.ts. */

import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  openCheckoutBundle,
  rewriteCheckoutBundle,
  sealCheckoutBundle,
} from "#db/checkout-bundles.ts";
import { execute, queryAll, queryOne } from "#db/client.ts";
import { sql } from "#db/sql.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

const ORDER = { email: "pat@example.com", items: '[{"e":1,"p":500,"q":1}]' };

/** The one stored bundle of a test. */
const onlyRow = () =>
  queryOne<{ sealed: string; token_index: string }>(
    sql`SELECT token_index, sealed FROM checkout_bundles`,
  );

describeWithEnv("checkout bundles", { db: true }, () => {
  test("opens what was sealed, with the token alone", async () => {
    const token = await sealCheckoutBundle(ORDER);

    expect(await openCheckoutBundle(token)).toEqual({
      record: ORDER,
      status: "opened",
    });
  });

  test("rewrites the bundle of its own token only, and keeps the time it was sealed", async () => {
    const settled = await sealCheckoutBundle(ORDER);
    const other = await sealCheckoutBundle({
      ...ORDER,
      email: "sam@example.com",
    });
    const sealedAt = () =>
      queryAll<{ created_at: string }>(
        sql`SELECT created_at FROM checkout_bundles ORDER BY created_at`,
      );
    const before = await sealedAt();

    await rewriteCheckoutBundle(settled, { items: ORDER.items });

    expect(await openCheckoutBundle(settled)).toEqual({
      record: { items: ORDER.items },
      status: "opened",
    });
    expect(await openCheckoutBundle(other)).toEqual({
      record: { ...ORDER, email: "sam@example.com" },
      status: "opened",
    });
    expect(await sealedAt()).toEqual(before);
  });

  test("refuses to seal a record that holds a value that is not text", async () => {
    const record = JSON.parse('{"items":7}');

    await expect(sealCheckoutBundle(record)).rejects.toThrow(
      "Invalid value for stored JSON in checkout bundle",
    );
    expect(await onlyRow()).toBeNull();
  });

  test("gives each order its own token", async () => {
    const first = await sealCheckoutBundle(ORDER);
    const second = await sealCheckoutBundle(ORDER);

    expect(first).not.toBe(second);
  });

  test("rests the order sealed, and never rests the token", async () => {
    const token = await sealCheckoutBundle(ORDER);

    const row = await onlyRow();
    assert(row !== null);
    assert(!row.sealed.includes("pat@example.com"));
    assert(!JSON.stringify(row).includes(token));
  });

  test("reads an unknown token as missing", async () => {
    expect(await openCheckoutBundle("never-sealed")).toEqual({
      status: "missing",
    });
  });

  test("reads a row whose sealed text was changed as unreadable", async () => {
    const token = await sealCheckoutBundle(ORDER);
    await execute(sql`UPDATE checkout_bundles SET sealed = ${"enc:1:AAAA"}`);

    expect(await openCheckoutBundle(token)).toEqual({ status: "unreadable" });
  });

  test("spends one database call to open a bundle", async () => {
    const token = await sealCheckoutBundle(ORDER);

    const calls = await countDatabaseCalls(1, () => openCheckoutBundle(token));

    expect(calls).toBe(1);
  });
});
