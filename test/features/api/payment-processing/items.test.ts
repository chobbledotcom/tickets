import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { validateAllItems } from "#routes/api/payment-processing/items.ts";
import { groups } from "#shared/db/groups.ts";
import { listingChildren } from "#shared/db/listing-parents.ts";
import { listingsTable } from "#shared/db/listings/records.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createTestListing,
  deactivateTestListing,
  updateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { webhookMeta } from "#test-utils/factories.ts";

const session = {
  amountTotal: 1000,
  id: "item-session",
  metadata: webhookMeta({ name: "Buyer" }),
  paymentReference: "payment",
  paymentStatus: "paid" as const,
};
const intent = (items: { e: number; p: number; q: number }[]) => ({
  address: "",
  date: null,
  email: "buyer@example.com",
  items,
  modifiers: [],
  name: "Buyer",
  phone: "",
  special_instructions: "",
});

const makeFoldedChild = async (
  parentSetup: Parameters<typeof createTestListing>[0] = {},
) => {
  const parent = await createTestListing({ unitPrice: 1000, ...parentSetup });
  const child = await createTestListing({ bookableAlone: true });
  await listingChildren.setIds(parent.id, [child.id]);
  await listingsTable.update(child.id, { bookableAlone: false });
  return { child, parent };
};

const foldedIntent = (
  parentId: number,
  childId: number,
  childQuantity: number,
) => ({
  ...intent([
    { e: parentId, p: 1000, q: 1 },
    { e: childId, p: 0, q: childQuantity },
  ]),
  allocations: [{ childId, parentId, qty: 1 }],
});

describeWithEnv("payment item validation", { db: true }, () => {
  test("returns a 404 failure for a missing listing", async () => {
    expect(
      await validateAllItems(session, intent([{ e: 99999, p: 1000, q: 1 }])),
    ).toEqual({
      error: "Listing not found",
      refundCode: "listing_removed",
      status: 404,
      success: false,
    });
  });

  test("loads active items and computes their current prices", async () => {
    const listing = await createTestListing({ unitPrice: 750 });
    const result = await validateAllItems(
      session,
      intent([{ e: listing.id, p: 1500, q: 2 }]),
    );
    expect(result).toMatchObject({
      items: [{ expectedPrice: 1500, item: { q: 2 } }],
      ok: true,
    });
  });

  test("names an inactive listing only in a multi-item order", async () => {
    const first = await createTestListing({ name: "Closed one" });
    const second = await createTestListing({ name: "Other" });
    await deactivateTestListing(first.id);
    const result = await validateAllItems(
      session,
      intent([
        { e: first.id, p: 0, q: 1 },
        { e: second.id, p: 0, q: 1 },
      ]),
    );
    expect(result).toMatchObject({
      error: "Closed one is no longer accepting registrations.",
      status: 410,
    });
  });

  test("uses the generic inactive message for one item", async () => {
    const listing = await createTestListing();
    await deactivateTestListing(listing.id);
    expect(
      await validateAllItems(session, intent([{ e: listing.id, p: 0, q: 1 }])),
    ).toMatchObject({
      error: "This listing is no longer accepting registrations.",
      status: 410,
    });
  });

  test("uses the generic closed message for one item and the name for many", async () => {
    const closed = await createTestListing({ name: "Timed out" });
    await updateTestListing(closed.id, { closesAt: "2000-01-01T00:00" });
    const other = await createTestListing();
    expect(
      await validateAllItems(session, intent([{ e: closed.id, p: 0, q: 1 }])),
    ).toMatchObject({
      error: "Sorry, registration closed while you were completing payment.",
      status: 410,
    });
    expect(
      await validateAllItems(
        session,
        intent([
          { e: closed.id, p: 0, q: 1 },
          { e: other.id, p: 0, q: 1 },
        ]),
      ),
    ).toMatchObject({
      error:
        "Sorry, registration for Timed out closed while you were completing payment.",
      status: 410,
    });
  });

  test("fails a stale standalone hidden package member closed", async () => {
    const group = await createTestGroup({ isPackage: true });
    const listing = await createTestListing({
      groupId: group.id,
      unitPrice: 500,
    });
    await groups.table.update(group.id, { hidePackageListings: true });
    const result = await validateAllItems(
      session,
      intent([{ e: listing.id, p: 500, q: 1 }]),
    );
    expect(result).toMatchObject({
      items: [{ expectedPrice: null }],
      ok: true,
    });
  });

  test("fails a stale standalone child but accepts a fully folded child", async () => {
    const { child, parent } = await makeFoldedChild();
    expect(
      await validateAllItems(session, intent([{ e: child.id, p: 0, q: 1 }])),
    ).toMatchObject({ items: [{ expectedPrice: null }], ok: true });
    expect(
      await validateAllItems(session, foldedIntent(parent.id, child.id, 1)),
    ).toMatchObject({
      items: [{ expectedPrice: 1000 }, { expectedPrice: 0 }],
      ok: true,
    });
    expect(
      await validateAllItems(session, foldedIntent(parent.id, child.id, 2)),
    ).toMatchObject({
      items: [{ expectedPrice: null }, { expectedPrice: null }],
      ok: true,
    });
  });

  test("checks folded surplus when package tags remove every standalone line", async () => {
    const group = await createTestGroup({ isPackage: true });
    const { child, parent } = await makeFoldedChild({ groupId: group.id });
    const result = await validateAllItems(session, {
      ...foldedIntent(parent.id, child.id, 2),
      items: [
        { e: parent.id, k: "p", p: 1000, q: 1, r: group.id },
        { e: child.id, p: 0, q: 2 },
      ],
    });
    expect(result).toMatchObject({
      items: [{ expectedPrice: null }, { expectedPrice: null }],
      ok: true,
    });
  });

  test("fails a package membership mismatch on its own", async () => {
    const group = await createTestGroup({ isPackage: true });
    const first = await createTestListing({ groupId: group.id });
    await createTestListing({ groupId: group.id });
    const result = await validateAllItems(session, {
      ...intent([{ e: first.id, p: 0, q: 1 }]),
      items: [{ e: first.id, k: "p", p: 0, q: 1, r: group.id }],
    });
    expect(result).toMatchObject({
      items: [{ expectedPrice: null }],
      ok: true,
    });
  });
});
