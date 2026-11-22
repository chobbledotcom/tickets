/** The sealed order of a card checkout: only the provider's copy of the token
 * opens it, a dump alone reads nothing, and the payments clock prunes it. */

import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  openCheckoutBundle,
  sealCheckoutBundle,
} from "#db/checkout-bundles.ts";
import { execute, queryOne } from "#db/client.ts";
import { runDatabasePruning } from "#db/prune.ts";
import { sql } from "#db/sql.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

const ORDER = { email: "pat@example.com", items: '[{"e":1,"p":500,"q":1}]' };

/** The one stored bundle of a test. */
const onlyRow = () =>
  queryOne<{ sealed: string; token_index: string }>(
    sql`SELECT token_index, sealed FROM checkout_bundles`,
  );

/** Move every stored bundle far past any clock. */
const ageEveryBundle = () =>
  execute(
    sql`UPDATE checkout_bundles SET created_at = ${"1926-01-01T00:00:00.000Z"}`,
  );

describeWithEnv("checkout bundles", { db: true }, () => {
  test("opens what was sealed, with the token alone", async () => {
    const token = await sealCheckoutBundle(ORDER);

    expect(await openCheckoutBundle(token)).toEqual({
      record: ORDER,
      status: "opened",
    });
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

  test("prunes an old bundle and keeps a new one", async () => {
    const old = await sealCheckoutBundle(ORDER);
    await ageEveryBundle();
    const young = await sealCheckoutBundle(ORDER);

    await runDatabasePruning();

    expect(await openCheckoutBundle(old)).toEqual({ status: "missing" });
    expect((await openCheckoutBundle(young)).status).toBe("opened");
  });
});
