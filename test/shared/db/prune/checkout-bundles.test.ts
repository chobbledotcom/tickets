/** The prune of sealed checkout orders: a bundle goes when its checkout window
 * and the provider retry window are over, and a younger one stays. The rule
 * for how long is checked beside it, in test/shared/db/checkout-bundles.test.ts. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  openCheckoutBundle,
  sealCheckoutBundle,
} from "#db/checkout-bundles.ts";
import { execute } from "#db/client.ts";
import { runDatabasePruning } from "#db/prune.ts";
import { sql } from "#db/sql.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const ORDER = { email: "pat@example.com", items: '[{"e":1,"p":500,"q":1}]' };

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** How long the prune keeps a bundle: the 60 minutes in which the checkout
 * can be paid, then the 3 days in which the provider can retry. */
const KEPT_FOR_MS = 60 * MINUTE_MS + 3 * DAY_MS;

const isoAgo = (ageMs: number) => new Date(Date.now() - ageMs).toISOString();

/** Make the bundles sealed in the last hour `ageMs` old. */
const ageNewBundles = (ageMs: number) =>
  execute(
    sql`UPDATE checkout_bundles SET created_at = ${isoAgo(ageMs)} WHERE created_at > ${isoAgo(60 * MINUTE_MS)}`,
  );

describeWithEnv("pruning checkout bundles", { db: true }, () => {
  test("prunes a bundle past its checkout and retry windows, and keeps a younger one", async () => {
    const old = await sealCheckoutBundle(ORDER);
    await ageNewBundles(KEPT_FOR_MS + MINUTE_MS);
    const young = await sealCheckoutBundle(ORDER);
    await ageNewBundles(KEPT_FOR_MS - MINUTE_MS);

    await runDatabasePruning();

    expect(await openCheckoutBundle(old)).toEqual({ status: "missing" });
    expect((await openCheckoutBundle(young)).status).toBe("opened");
  });
});
