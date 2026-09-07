import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { groups, setGroupPackageMembers } from "#db/groups.ts";
import { listingsTable } from "#db/listings/records.ts";
import { validateAllItems } from "#routes/api/payment-processing/items.ts";
import { loadPaidOrderSnapshot } from "#routes/api/payment-processing/snapshot/io.ts";
import type { BookingIntent } from "#shared/booking-intent.ts";
import { paymentSession } from "#test/features/api/payment-processing/index/helpers.ts";
import { packageParentOrder } from "#test/features/api/payment-processing/items/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createTestListing,
  pastCloseTime,
} from "#test-utils/db-helpers/listings.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { stubRefundPayment } from "#test-utils/webhooks/stripe.ts";

const cases = [
  { name: "package-only child", path: "package", safeName: "Parent bundle" },
  { name: "standalone surplus", path: "surplus", safeName: "Private child" },
  {
    name: "zero-quantity standalone parent",
    path: "zero-parent",
    safeName: "Parent bundle",
  },
  {
    name: "selected standalone parent path",
    path: "standalone-parent",
    safeName: "Private child",
  },
  {
    name: "selected named package parent path",
    path: "named-parent",
    safeName: "Private child",
  },
  {
    name: "offered but unselected named package path",
    path: "offered",
    safeName: "Parent bundle",
  },
  {
    name: "selected named listing without a child allocation",
    path: "unallocated",
    safeName: "Parent bundle",
  },
  { name: "missing package display", path: "missing", safeName: "" },
] as const;

const childOrder = async (
  path: (typeof cases)[number]["path"],
): Promise<BookingIntent> => {
  const { intent } = await packageParentOrder(path === "surplus" ? 2 : 1);
  const [parent, child] = intent.items;
  const allocation = intent.allocations?.[0];
  assert(parent?.r !== undefined && child && allocation);
  await groups.table.update(parent.r, { hidePackageListings: true });

  if (path === "offered" || path === "named-parent") {
    const named = await createTestGroup({ isPackage: true });
    await setGroupPackageMembers(named.id, [
      { listingId: parent.e, price: 600 },
    ]);
    if (path === "named-parent") {
      intent.items.push({ ...parent, r: named.id });
    }
  }
  if (path === "standalone-parent") {
    intent.items.push({ e: parent.e, p: 600, q: 1 });
  }
  if (path === "zero-parent") {
    intent.items.push({ e: parent.e, p: 0, q: 0 });
  }
  if (path === "named-parent" || path === "standalone-parent") {
    allocation.qty = 2;
    child.q = 2;
    child.p = 400;
  }
  if (path === "unallocated") {
    const unrelated = await createTestListing({ unitPrice: 600 });
    intent.items.push({ e: unrelated.id, p: 600, q: 1 });
  }
  return intent;
};

const checkChildName = async (
  { path, safeName }: (typeof cases)[number],
  state: "inactive" | "closed" | "active",
): Promise<void> => {
  await setupStripe();
  const intent = await childOrder(path);
  const child = intent.items[1];
  assert(child);
  await listingsTable.update(child.e, {
    active: state !== "inactive",
    bookableAlone: true,
    closesAt: state === "closed" ? pastCloseTime() : null,
    name: "Private child",
  });
  const amount = intent.items.reduce((total, item) => total + item.p, 0);
  const session = paymentSession("cs_child_names", amount, intent);
  const snapshot = await loadPaidOrderSnapshot(session.id, intent);
  if (path === "missing") {
    snapshot.notificationPackages.displays = new Map();
  }
  using refund = stubRefundPayment("re_child_names", amount);

  const result = await validateAllItems(session, intent, snapshot);
  if (state === "active") {
    assert("ok" in result && result.ok);
    expect(result.items[1]?.name).toBe(safeName);
    expect(result.items[0]?.name).toBe(
      path === "missing" ? "" : "Parent bundle",
    );
    expect(refund.calls).toHaveLength(0);
    return;
  }
  const error =
    state === "inactive"
      ? `${safeName || "This listing"} is no longer accepting registrations.`
      : `Sorry, registration${safeName ? ` for ${safeName}` : ""} closed while you were completing payment.`;
  expect(result).toMatchObject({
    error,
    refunded: true,
    status: 410,
    success: false,
  });
  expect(refund.calls).toHaveLength(1);
};

describeWithEnv("paid child names", { db: true }, () => {
  for (const scenario of cases) {
    for (const state of ["inactive", "closed", "active"] as const) {
      test(`${state}: ${scenario.name}`, () => checkChildName(scenario, state));
    }
  }
});
