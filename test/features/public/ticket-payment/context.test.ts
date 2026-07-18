import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  dropChildListings,
  getTicketContext,
  keepParentDailyDatesChildrenCanServe,
  lacksStandalonePublicPage,
  parentRequiresChild,
  withActiveListings,
} from "#routes/public/ticket-payment.ts";
import { buildTicketListing } from "#shared/booking/model.ts";
import { getBookableStartDates } from "#shared/dates.ts";
import { groups } from "#shared/db/groups.ts";
import { listingChildren } from "#shared/db/listing-parents.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import { settings } from "#shared/db/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestHoliday } from "#test-utils/db-helpers/holidays.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

const ticketListing = (id: number, overrides = {}) =>
  buildTicketListing(
    testListingWithCount({ id, ...overrides }),
    false,
    undefined,
  );

const createDailyParentWithMondayChild = async (groupId?: number) => {
  const parent = await createDailyTestListing({
    ...(groupId === undefined ? {} : { groupId }),
    maximumDaysAfter: 6,
    minimumDaysBefore: 0,
  });
  const child = await createDailyTestListing({
    bookableDays: ["Monday"],
    maximumDaysAfter: 6,
    minimumDaysBefore: 0,
  });
  await listingChildren.setIds(parent.id, [child.id]);
  const parentRow = await getListingWithCount(parent.id);
  const childRow = await getListingWithCount(child.id);
  if (parentRow === null || childRow === null) {
    throw new Error("Daily parent or child listing not found");
  }
  return {
    child,
    childDates: getBookableStartDates(childRow, []),
    parent,
    parentRow,
  };
};

describeWithEnv("ticket payment context", { db: true }, () => {
  test("identifies each reason a listing lacks a standalone page", async () => {
    const plain = await createTestListing();
    expect(await lacksStandalonePublicPage(plain.id)).toBe(false);

    const parent = await createTestListing();
    const child = await createTestListing({ bookableAlone: false });
    await listingChildren.setIds(parent.id, [child.id]);
    expect(await lacksStandalonePublicPage(child.id)).toBe(true);

    const group = await createTestGroup({
      hidePackageListings: true,
      isPackage: true,
    });
    await groups.table.update(group.id, { hidePackageListings: true });
    const hidden = await createTestListing({ groupId: group.id });
    expect(await lacksStandalonePublicPage(hidden.id)).toBe(true);
  });

  test("drops children but keeps their parent and unrelated listings", async () => {
    const parent = await createTestListing();
    const child = await createTestListing();
    const other = await createTestListing();
    await listingChildren.setIds(parent.id, [child.id]);
    const result = await dropChildListings([
      (await getListingWithCount(parent.id))!,
      (await getListingWithCount(child.id))!,
      (await getListingWithCount(other.id))!,
    ]);
    expect(result.map((listing) => listing.id)).toEqual([parent.id, other.id]);
  });

  test("reports whether a listing requires a child", async () => {
    const parent = await createTestListing();
    const child = await createTestListing();
    expect(await parentRequiresChild(parent.id)).toBe(false);
    await listingChildren.setIds(parent.id, [child.id]);
    expect(await parentRequiresChild(parent.id)).toBe(true);
  });

  test("loads one active listing and rejects missing or child slugs", async () => {
    const parent = await createTestListing();
    const child = await createTestListing({ bookableAlone: false });
    await listingChildren.setIds(parent.id, [child.id]);
    const handled = await withActiveListings([parent.slug], (listings) =>
      Promise.resolve(
        new Response(String(listings[0]!.listing.id), { status: 201 }),
      ),
    );
    expect(handled.status).toBe(201);
    expect(await handled.text()).toBe(String(parent.id));
    expect(
      (await withActiveListings(["missing"], () => new Response())).status,
    ).toBe(404);
    expect(
      (await withActiveListings([child.slug], () => new Response())).status,
    ).toBe(404);
  });

  test("rejects a hidden package member slug", async () => {
    const group = await createTestGroup({ isPackage: true });
    await groups.table.update(group.id, { hidePackageListings: true });
    const member = await createTestListing({ groupId: group.id });
    const response = await withActiveListings(
      [member.slug],
      () => new Response("handled", { status: 201 }),
    );
    expect(response.status).toBe(404);
  });

  test("sets gallery targets for group, single-listing, and multi-listing pages", async () => {
    const group = await createTestGroup({ name: "Gallery group" });
    const grouped = await getTicketContext([], group);
    expect(grouped.galleryTarget).toEqual({ id: group.id, type: "group" });

    const single = await getTicketContext([ticketListing(101)]);
    expect(single.galleryTarget).toEqual({ id: 101, type: "listing" });

    const multiple = await getTicketContext([
      ticketListing(102),
      ticketListing(103),
    ]);
    expect(multiple.galleryTarget).toBe(null);
  });

  test("an explicit empty package list stays empty on a package group page", async () => {
    const group = await createTestGroup({
      isPackage: true,
      name: "Empty package",
    });
    const context = await getTicketContext([], group, []);
    expect(context.packages).toEqual([]);
    expect(context.packageMemberGroupIds.size).toBe(0);
    expect(context.packageGroupRemainingByGroupId.size).toBe(0);
  });

  test("group terms win and blank group terms use the global fallback", async () => {
    await settings.update.terms("Global terms");
    const group = await createTestGroup({
      name: "Terms",
      termsAndConditions: "Group terms",
    });
    expect((await getTicketContext([], group)).terms).toBe("Group terms");
    await groups.table.update(group.id, { termsAndConditions: "" });
    const updatedGroup = await groups.table.findById(group.id);
    if (updatedGroup === null) throw new Error("Updated group not found");
    expect((await getTicketContext([], updatedGroup)).terms).toBe(
      "Global terms",
    );
    expect((await getTicketContext([])).terms).toBe("Global terms");
    await settings.update.terms("");
    expect((await getTicketContext([])).terms).toBe("");
  });

  test("a parent with no children keeps every supplied daily date", async () => {
    const parent = testListingWithCount({ id: 999, listing_type: "daily" });
    const dates = ["2030-01-01", "2030-01-02"];
    expect(
      await keepParentDailyDatesChildrenCanServe(parent, dates, []),
    ).toEqual(dates);
  });

  test("a daily child removes parent dates it cannot serve", async () => {
    const { child, childDates, parent, parentRow } =
      await createDailyParentWithMondayChild();
    const parentDates = getBookableStartDates(parentRow, []);
    const childDate = childDates[0]!;
    const parentOnlyDate = parentDates.find(
      (date) => !childDates.includes(date),
    )!;
    expect(
      await keepParentDailyDatesChildrenCanServe(
        parentRow,
        [childDate, parentOnlyDate],
        [],
      ),
    ).toEqual([childDate]);

    await createTestHoliday({
      endDate: childDate,
      name: "Child date closed",
      startDate: childDate,
    });
    const context = await getTicketContext([
      buildTicketListing(parentRow, false, undefined),
    ]);
    expect(
      context.childrenByParentId
        .get(parent.id)
        ?.map((entry) => entry.listing.id),
    ).toEqual([child.id]);
    expect(context.childDatesById.size).toBe(1);
    expect(context.dates).not.toContain(childDate);
    expect(context.dates.every((date) => childDates.includes(date))).toBe(true);
  });

  test("a multi-member daily package keeps only dates its parent member's child can serve", async () => {
    const group = await createTestGroup({ isPackage: true });
    const { childDates, parentRow } = await createDailyParentWithMondayChild(
      group.id,
    );
    const otherMember = await createDailyTestListing({
      groupId: group.id,
      maximumDaysAfter: 6,
      minimumDaysBefore: 0,
    });
    const parentInfo = buildTicketListing(parentRow, false, undefined);
    const otherInfo = buildTicketListing(
      (await getListingWithCount(otherMember.id))!,
      false,
      undefined,
    );
    const context = await getTicketContext([parentInfo, otherInfo], group);
    expect(context.packages).toHaveLength(1);
    expect(context.dates.length).toBeGreaterThan(0);
    expect(context.dates.every((date) => childDates.includes(date))).toBe(true);
  });
});
