import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { costAccount, revenueAccount, WORLD } from "#accounting/accounts.ts";
import { bookingEventGroup } from "#accounting/mappers.ts";
import { postTransfers } from "#accounting/store.ts";
import { execute } from "#db/client.ts";
import { hashEmail, hashPhone } from "#db/contact-preferences.ts";
import { setGroupPackageMembers, setListingGroups } from "#db/groups.ts";
import { listingChildren } from "#db/listing-parents.ts";
import {
  modifierGroups,
  modifierListings,
  modifiersTable,
} from "#db/modifiers.ts";
import { loadPaidOrderSnapshot } from "#routes/api/payment-processing/snapshot/io.ts";
import { priceCheckout } from "#shared/checkout-pricing.ts";
import { bookingIntent } from "#test/features/api/payment-processing/index/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import {
  createHiddenPackageGroup,
  createTestGroup,
} from "#test-utils/db-helpers/groups.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

const loadStaleScopePricing = async (scope: "groups" | "listings") => {
  const listingLink = await createTestListing({
    name: "Listing link",
    unitPrice: 1000,
  });
  const groupLink = await createTestListing({
    name: "Group link",
    unitPrice: 3000,
  });
  const group = await createTestGroup({ name: "Modifier group" });
  await setListingGroups(groupLink.id, [group.id]);
  const modifier = await modifiersTable.insert({
    calcKind: "percent",
    calcValue: 10,
    direction: "charge",
    name: "Scoped charge",
    scope,
  });
  await modifierListings.setIds(modifier.id, [listingLink.id]);
  await modifierGroups.setIds(modifier.id, [group.id]);

  const intent = bookingIntent(
    [
      { e: listingLink.id, p: listingLink.unit_price, q: 1 },
      { e: groupLink.id, p: groupLink.unit_price, q: 1 },
    ],
    { modifiers: [{ i: modifier.id, q: 1 }] },
  );
  const snapshot = await loadPaidOrderSnapshot(`stale-${scope}-scope`, intent);
  const pricing = priceCheckout({
    address: intent.address,
    date: intent.date,
    email: intent.email,
    items: [listingLink, groupLink].map((listing) => ({
      listingId: listing.id,
      name: listing.name,
      quantity: 1,
      slug: listing.slug,
      unitPrice: listing.unit_price,
    })),
    modifiers: snapshot.modifierSpecs,
    name: intent.name,
    phone: intent.phone,
    special_instructions: intent.special_instructions,
  });
  return { groupLink, listingLink, modifier, pricing, snapshot };
};

describeWithEnv("paid order snapshot IO", { db: true }, () => {
  test("loads one paid line in one database call", async () => {
    const listing = await createTestListing({ unitPrice: 500 });
    const intent = bookingIntent([{ e: listing.id, p: 500, q: 1 }]);

    const calls = await countDatabaseCalls(10, () =>
      loadPaidOrderSnapshot("snapshot-one", intent),
    );

    expect(calls).toBe(1);
  });

  test("loads many paid lines in the same one database call", async () => {
    const listings = [
      await createTestListing({ unitPrice: 500 }),
      await createTestListing({ unitPrice: 700 }),
    ];
    const intent = bookingIntent(
      listings.map((listing) => ({
        e: listing.id,
        p: listing.unit_price,
        q: 1,
      })),
    );

    const calls = await countDatabaseCalls(10, () =>
      loadPaidOrderSnapshot("snapshot-many", intent),
    );

    expect(calls).toBe(1);
  });

  test("does not take an owner from another ledger event", async () => {
    const listing = await createTestListing({ unitPrice: 500 });
    const { attendee } = await createTestAttendeeDirect(
      listing.id,
      "Other event buyer",
      "other-event@example.com",
    );
    const requestedGroup = await bookingEventGroup("snapshot-requested-event");
    const otherGroup = await bookingEventGroup("snapshot-other-event");
    await execute(
      "UPDATE listing_attendees SET ledger_event_group = ? WHERE attendee_id = ?",
      [otherGroup, attendee.id],
    );
    await postTransfers([
      {
        amount: 500,
        destination: revenueAccount(listing.id),
        eventGroup: requestedGroup,
        kind: "manual_income",
        occurredAt: "2026-08-06T00:00:00.000Z",
        reference: "snapshot-requested-income",
        source: WORLD,
      },
    ]);

    const snapshot = await loadPaidOrderSnapshot(
      "snapshot-requested-event",
      bookingIntent([{ e: listing.id, p: 500, q: 1 }]),
    );

    expect(snapshot.ledger).toEqual({ status: "orphaned" });
  });

  test("loads a standalone listing when optional selections are empty", async () => {
    const listing = await createTestListing({ name: "Standalone" });

    const snapshot = await loadPaidOrderSnapshot(
      "snapshot-empty-selections",
      bookingIntent([{ e: listing.id, p: 0, q: 1 }]),
    );

    expect(snapshot.listingsById.get(listing.id)?.name).toBe("Standalone");
    expect(snapshot.notificationPackages.pricingByGroup).toEqual(new Map());
    expect(snapshot.modifierSpecs).toEqual([]);
  });

  test("ignores stale group links for a listing-scoped modifier", async () => {
    const { listingLink, modifier, pricing, snapshot } =
      await loadStaleScopePricing("listings");

    expect(snapshot.modifierSpecs).toEqual([
      {
        id: modifier.id,
        kind: "percent",
        listingIds: [listingLink.id],
        name: "Scoped charge",
        quantity: 1,
        trigger: "automatic",
        value: 10,
      },
    ]);
    expect(pricing.modifierApplications).toEqual([
      {
        amountApplied: 100,
        delta: 100,
        modifierId: modifier.id,
        name: "Scoped charge",
        quantity: 1,
        scopedSubtotal: 1000,
      },
    ]);
    expect(pricing.total).toBe(4100);
  });

  test("ignores stale listing links for a group-scoped modifier", async () => {
    const { groupLink, modifier, pricing, snapshot } =
      await loadStaleScopePricing("groups");

    expect(snapshot.modifierSpecs).toEqual([
      {
        id: modifier.id,
        kind: "percent",
        listingIds: [groupLink.id],
        name: "Scoped charge",
        quantity: 1,
        trigger: "automatic",
        value: 10,
      },
    ]);
    expect(pricing.modifierApplications).toEqual([
      {
        amountApplied: 300,
        delta: 300,
        modifierId: modifier.id,
        name: "Scoped charge",
        quantity: 1,
        scopedSubtotal: 3000,
      },
    ]);
    expect(pricing.total).toBe(4300);
  });

  test("loads every paid order fact from one consistent snapshot", async () => {
    const pkg = await createHiddenPackageGroup("Snapshot package");
    const parent = await createDailyTestListing({
      customisableDays: true,
      dayPrices: { 2: 900 },
      durationDays: 2,
      groupId: pkg.id,
      name: "Snapshot parent",
      unitPrice: 500,
    });
    const child = await createTestListing({ name: "Snapshot child" });
    await listingChildren.setIds(parent.id, [child.id]);
    await setGroupPackageMembers(pkg.id, [
      {
        dayPrices: { 2: 700 },
        listingId: parent.id,
        price: 400,
        quantity: 2,
      },
    ]);

    const directModifier = await modifiersTable.insert({
      calcKind: "fixed",
      calcValue: 5,
      direction: "discount",
      minVisits: 3,
      name: "Direct discount",
      scope: "listings",
    });
    const groupModifier = await modifiersTable.insert({
      calcKind: "percent",
      calcValue: 10,
      direction: "charge",
      name: "Package charge",
      scope: "groups",
    });
    await modifierListings.setIds(directModifier.id, [parent.id]);
    await modifierGroups.setIds(groupModifier.id, [pkg.id]);

    const email = "snapshot@example.com";
    const phone = "+447700900123";
    await execute(
      "INSERT INTO contact_preferences (contact_hash, visits, stats_blob) VALUES (?, ?, ?), (?, ?, ?)",
      [await hashEmail(email), 3, "{}", await hashPhone(phone), 7, "{}"],
    );

    const eventId = "snapshot-complete";
    const eventGroup = await bookingEventGroup(eventId);
    const { attendee } = await createTestAttendeeDirect(
      parent.id,
      "Snapshot buyer",
      email,
    );
    await execute(
      "UPDATE listing_attendees SET ledger_event_group = ? WHERE attendee_id = ? AND listing_id = ?",
      [eventGroup, attendee.id, parent.id],
    );
    await postTransfers([
      {
        amount: 600,
        destination: revenueAccount(parent.id),
        eventGroup,
        kind: "manual_income",
        occurredAt: "2026-08-06T00:00:00.000Z",
        reference: "snapshot-income",
        source: WORLD,
      },
      {
        amount: 250,
        destination: WORLD,
        eventGroup,
        kind: "manual_cost",
        occurredAt: "2026-08-06T00:00:00.000Z",
        reference: "snapshot-cost",
        source: costAccount(parent.id),
      },
    ]);

    const intent = bookingIntent(
      [{ e: parent.id, k: "p", p: 800, q: 2, r: pkg.id }],
      {
        email,
        modifiers: [
          { i: directModifier.id, q: 2 },
          { i: groupModifier.id, q: 1 },
        ],
        phone,
      },
    );
    const snapshot = await loadPaidOrderSnapshot(eventId, intent);

    expect(snapshot.ledger).toEqual({
      attendeeId: attendee.id,
      status: "booked",
    });
    expect(snapshot.listingsById.get(parent.id)).toMatchObject({
      cost: 250,
      income: 600,
      name: "Snapshot parent",
    });
    expect(snapshot.listingsById.get(child.id)?.name).toBe("Snapshot child");
    expect(snapshot.childrenByParentId).toEqual(
      new Map([[parent.id, [child.id]]]),
    );
    expect(snapshot.parentsByChildId).toEqual(
      new Map([[child.id, [parent.id]]]),
    );
    expect(snapshot.hiddenPackageMemberIds).toEqual(new Set([parent.id]));
    expect(snapshot.notificationPackages.displays.get(pkg.id)).toEqual({
      hideListings: true,
      name: "Snapshot package",
    });
    expect(snapshot.notificationPackages.pricingByGroup.get(pkg.id)).toEqual({
      dayPriceMap: new Map([[parent.id, new Map([[2, 700]])]]),
      memberIds: new Set([parent.id]),
      priceMap: new Map([[parent.id, 400]]),
      quantityMap: new Map([[parent.id, 2]]),
    });
    expect(snapshot.modifierSpecs).toEqual([
      {
        id: directModifier.id,
        kind: "fixed",
        listingIds: [parent.id],
        name: "Direct discount",
        quantity: 2,
        trigger: "automatic",
        value: -500,
      },
      {
        id: groupModifier.id,
        kind: "percent",
        listingIds: [parent.id],
        name: "Package charge",
        quantity: 1,
        trigger: "automatic",
        value: 10,
      },
    ]);
  });
});
