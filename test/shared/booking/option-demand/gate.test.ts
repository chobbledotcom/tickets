/**
 * The submitted-cart gate's own tests: a closed option refuses with the
 * walk's sold-out message, and a package member nothing books never makes
 * the package's question run. The declared case table drives the rest of
 * the gate through ./surfaces.test.ts.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { FoldBase } from "#booking/fold-tree.ts";
import type { PagePackage } from "#booking/page-packages.ts";
import type { JudgeCartCtx } from "#routes/public/judge-cart.ts";
import { judgeSubmittedCart } from "#routes/public/judge-cart.ts";
import { buildTicketListingsWithGroupCapacity } from "#routes/public/ticket-listings.ts";
import { FormParams } from "#shared/form-data.ts";
import { requireValue } from "#shared/required-value.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  pastCloseTime,
} from "#test-utils/db-helpers/listings.ts";
import { pagePackage } from "#test-utils/package-cap-fixtures.ts";
import type { ListingWithCount } from "#types";

/** The gate's judgement inputs for one cart: the rows enriched with their
 * availability flags, the fold base carrying the submitted quantities, and
 * an empty form. */
const gateCart = async (
  rows: readonly ListingWithCount[],
  quantities: Map<number, number>,
  packages: readonly PagePackage[],
) => {
  const enrichedRows = (
    await buildTicketListingsWithGroupCapacity([...rows])
  ).map((row) => requireValue(row, "The gate fixture row is missing"));
  const base: FoldBase = {
    customPrices: new Map(),
    date: null,
    dayCount: 1,
    hasCustomisable: false,
    quantities,
  };
  const ctx: JudgeCartCtx = {
    childrenByParentId: new Map(),
    listings: enrichedRows,
    packages: [...packages],
  };
  return { base, ctx, form: new FormParams() };
};

describeWithEnv("booking > the submitted-cart gate", { db: true }, () => {
  test("refuses an option whose registration closed", async () => {
    // A closed option is the refusal the fold's walk does not name: the
    // walk never reads the registration window. The gate refuses the
    // submission with the walk's own sold-out message, and a cart that
    // does not book the closed option passes.
    const closed = await createTestListing({
      closesAt: pastCloseTime(),
      name: "Closed Trip",
    });
    const open = await createTestListing({ name: "Open Trip" });
    const { base, ctx, form } = await gateCart(
      [closed, open],
      new Map([[closed.id, 1]]),
      [],
    );
    expect(judgeSubmittedCart({ base, ctx, form, holidays: [] })).toEqual({
      error: "Closed Trip has no available options right now.",
      ok: false,
    });
    expect(
      judgeSubmittedCart({
        base: { ...base, quantities: new Map() },
        ctx,
        form,
        holidays: [],
      }),
    ).toEqual({ ok: true });
  });

  test("ignores a package member nothing books", async () => {
    // The cart's quantities aggregate the package and standalone paths:
    // a member booked standalone leaves its package siblings at zero,
    // and the fold skips them. The judge must skip them too — a closed
    // zero-quantity sibling must not refuse the booked member.
    const closed = await createTestListing({
      closesAt: pastCloseTime(),
      name: "Shut Sibling",
    });
    const booked = await createTestListing({ name: "Standalone Trip" });
    const { base, ctx, form } = await gateCart(
      [closed, booked],
      new Map([[booked.id, 1]]),
      [pagePackage(9, [closed.id, booked.id])],
    );
    expect(judgeSubmittedCart({ base, ctx, form, holidays: [] })).toEqual({
      ok: true,
    });
  });
});
