import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { withTransaction } from "#shared/db/client.ts";
import { listingChildren } from "#shared/db/listing-parents.ts";
import {
  getListingDayPrices,
  writeListingDayCounts,
} from "#shared/db/listing-prices.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { standardParentWithDailyChildEdge } from "#test-utils/listing-parents/helpers.ts";

describeWithEnv("listing day-price relationship check", { db: true }, () => {
  test("rolls back prices when an incoming edge is no longer valid", async () => {
    const { child } = await standardParentWithDailyChildEdge();

    await expect(
      withTransaction((tx) => writeListingDayCounts(tx, child.id, { 2: 900 })),
    ).rejects.toThrow(
      t("listings_table.children_err_child_daily", { name: child.name }),
    );
    expect(await getListingDayPrices(child.id)).toEqual({});
  });

  test("finishes relationship changes before checking final edges", async () => {
    const { parent } = await standardParentWithDailyChildEdge();

    await withTransaction((tx) =>
      writeListingDayCounts(tx, parent.id, { 2: 900 }, () =>
        listingChildren.setIdsTx(tx, parent.id, []),
      ),
    );

    expect(await getListingDayPrices(parent.id)).toEqual({ 2: 900 });
    expect(await listingChildren.getIds(parent.id)).toEqual([]);
  });
});
