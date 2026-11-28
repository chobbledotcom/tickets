/** The prune of sealed checkout orders: a bundle goes when the payments clock
 * has passed, and a younger one stays. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  openCheckoutBundle,
  sealCheckoutBundle,
} from "#db/checkout-bundles.ts";
import { runDatabasePruning } from "#db/prune.ts";
import { sql } from "#db/sql.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { runWrite } from "#test-utils/raw-db.ts";

const ORDER = { email: "pat@example.com", items: '[{"e":1,"p":500,"q":1}]' };

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** How long the prune keeps a bundle: the payments clock of 90 days. */
const KEPT_FOR_MS = 90 * DAY_MS;

const isoAgo = (ageMs: number) => new Date(Date.now() - ageMs).toISOString();

/** Make the bundles sealed in the last hour `ageMs` old. */
const ageNewBundles = (ageMs: number) =>
  runWrite(
    sql`UPDATE checkout_bundles SET created_at = ${isoAgo(ageMs)} WHERE created_at > ${isoAgo(60 * MINUTE_MS)}`,
  );

describeWithEnv("pruning checkout bundles", { db: true }, () => {
  test("prunes a bundle past the payments clock, and keeps a younger one", async () => {
    const old = await sealCheckoutBundle(ORDER);
    await ageNewBundles(KEPT_FOR_MS + MINUTE_MS);
    const young = await sealCheckoutBundle(ORDER);
    await ageNewBundles(KEPT_FOR_MS - MINUTE_MS);

    await runDatabasePruning();

    expect(await openCheckoutBundle(old)).toEqual({ status: "missing" });
    expect((await openCheckoutBundle(young)).status).toBe("opened");
  });
});
