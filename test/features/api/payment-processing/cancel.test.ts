import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { cancelResponseAfterClose } from "#routes/api/payment-processing/cancel.ts";
import { expectUnresolvedCancelResponse } from "#test-utils/checkout.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { singleItem, webhookMeta } from "#test-utils/factories.ts";
import { makeParent } from "#test-utils/parents.ts";

const cancelled = (items: string) => ({
  amountTotal: 0,
  id: "cancelled-session",
  metadata: webhookMeta({ items, name: "Buyer" }),
  paymentReference: "",
  paymentStatus: "failed" as const,
});

describeWithEnv("payment cancellation", { db: true }, () => {
  for (const closeResult of ["error", "kept"] as const) {
    test(`blocks retry after an unresolved ${closeResult} close`, async () => {
      const response = await cancelResponseAfterClose(
        cancelled(singleItem(1, 1, 0)),
        closeResult,
        () => {},
      );
      await expectUnresolvedCancelResponse(response);
    });
  }

  test("reports a missing first listing and its resolved id", async () => {
    const logs: string[] = [];
    const response = await cancelResponseAfterClose(
      cancelled("[]"),
      "missing",
      (detail) => logs.push(detail),
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Listing not found");
    expect(logs).toEqual([
      "Listing not found (session=cancelled-session, listingId=0)",
    ]);
  });

  test("links a standalone listing retry", async () => {
    const listing = await createTestListing();
    const html = await (
      await cancelResponseAfterClose(
        cancelled(singleItem(listing.id, 1, 0)),
        "purged",
        () => {},
      )
    ).text();
    expect(html).toContain(`/ticket/${listing.slug}`);
  });

  test("suppresses a retry for a non-standalone child", async () => {
    const { child } = await makeParent();
    const html = await (
      await cancelResponseAfterClose(
        cancelled(singleItem(child.id, 1, 0)),
        "purged",
        () => {},
      )
    ).text();
    expect(html).not.toContain(`/ticket/${child.slug}`);
  });

  test("links the first live package from a multi-package order", async () => {
    const deadId = 99999;
    const group = await createTestGroup({ isPackage: true });
    const listing = await createTestListing({ groupId: group.id });
    const items = JSON.stringify([
      { e: listing.id, k: "p", p: 0, q: 1, r: deadId },
      { e: listing.id, k: "p", p: 0, q: 1, r: group.id },
    ]);
    const html = await (
      await cancelResponseAfterClose(cancelled(items), "purged", () => {})
    ).text();
    expect(html).toContain(`/ticket/${group.slug}`);
  });
});
