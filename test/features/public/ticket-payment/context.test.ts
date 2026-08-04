import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  foldSelectedChildren,
  getTicketContext,
  parentRequiresChild,
  withActiveListings,
} from "#routes/public/ticket-payment.ts";
import type { TicketCtx } from "#routes/public/types.ts";
import { buildTicketListing } from "#shared/booking/model.ts";
import { setGroupPackageMembers } from "#shared/db/groups.ts";
import { holidays } from "#shared/db/holidays.ts";
import { listingChildren } from "#shared/db/listing-parents.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import { FormParams } from "#shared/form-data.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createHiddenPackageGroup,
  createTestGroup,
} from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { makeParent } from "#test-utils/parents.ts";
import { withSetting } from "#test-utils/settings.ts";

const allDays = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

const ticketListing = async (listingId: number) =>
  buildTicketListing((await getListingWithCount(listingId))!, false, undefined);

const ticketContext = async (listingId: number): Promise<TicketCtx> => {
  const listing = await ticketListing(listingId);
  return {
    ...(await getTicketContext([listing])),
    listings: [listing],
    slugs: [listing.listing.slug],
  };
};

const foldBase = (listingId: number, quantity: number) => ({
  customPrices: new Map<number, number>(),
  date: null,
  dayCount: 1,
  hasCustomisable: false,
  quantities: new Map([[listingId, quantity]]),
});

describeWithEnv("ticket context branches", { db: true }, () => {
  test("loads holidays only for a selected parent that has children", async () => {
    const plain = await createTestListing();
    const { parent, child } = await makeParent();
    const plainCtx = await ticketContext(plain.id);
    const parentCtx = await ticketContext(parent.id);
    using holidayRows = stub(holidays, "getAll", () => Promise.resolve([]));

    await foldSelectedChildren(
      plainCtx,
      new FormParams({}),
      foldBase(plain.id, 1),
    );
    expect(holidayRows.calls).toHaveLength(0);

    await foldSelectedChildren(
      parentCtx,
      new FormParams({}),
      foldBase(parent.id, 0),
    );
    expect(holidayRows.calls).toHaveLength(0);

    await foldSelectedChildren(parentCtx, new FormParams({}), {
      ...foldBase(parent.id, 0),
      quantities: new Map(),
    });
    expect(holidayRows.calls).toHaveLength(0);

    await foldSelectedChildren(
      parentCtx,
      new FormParams({ [`child_qty_${parent.id}_${child.id}`]: "1" }),
      foldBase(parent.id, 1),
    );
    expect(holidayRows.calls).toHaveLength(1);
  });

  test("reports whether a listing requires a child", async () => {
    const plain = await createTestListing();
    const { parent } = await makeParent();
    expect(await parentRequiresChild(parent.id)).toBe(true);
    expect(await parentRequiresChild(plain.id)).toBe(false);
  });

  test("loads holidays while building context for a parent with children", async () => {
    const { parent } = await makeParent();
    const listing = await ticketListing(parent.id);
    using holidayRows = stub(holidays, "getAll", () => Promise.resolve([]));

    await getTicketContext([listing]);

    expect(holidayRows.calls).toHaveLength(1);
  });

  test("rejects a hidden package member before calling the page handler", async () => {
    const group = await createHiddenPackageGroup("Hidden package");
    const member = await createTestListing({ groupId: group.id });
    await setGroupPackageMembers(group.id, [
      { listingId: member.id, price: null },
    ]);
    let handled = false;

    const response = await withActiveListings([member.slug], () => {
      handled = true;
      return new Response("handled");
    });

    expect(response.status).toBe(404);
    expect(handled).toBe(false);
  });

  test("a daily package parent keeps only dates its daily child can serve", async () => {
    const group = await createTestGroup({ isPackage: true });
    const parent = await createTestListing({
      bookableDays: allDays,
      durationDays: 1,
      groupId: group.id,
      listingType: "daily",
      maximumDaysAfter: 14,
      minimumDaysBefore: 0,
    });
    const child = await createTestListing({
      bookableDays: ["Monday"],
      durationDays: 1,
      listingType: "daily",
      maximumDaysAfter: 14,
      minimumDaysBefore: 0,
    });
    const companion = await createTestListing({ groupId: group.id });
    await listingChildren.setIds(parent.id, [child.id]);
    await setGroupPackageMembers(group.id, [
      { listingId: parent.id, price: null },
      { listingId: companion.id, price: null },
    ]);

    const ctx = await getTicketContext(
      [await ticketListing(parent.id), await ticketListing(companion.id)],
      group,
    );

    expect(ctx.dates.length).toBeGreaterThan(0);
    expect(
      ctx.dates.map((date) => new Date(`${date}T00:00:00Z`).getUTCDay()),
    ).toEqual(ctx.dates.map(() => 1));
  });

  test("shows a group's own terms ahead of the site's", async () => {
    const group = await createTestGroup({
      name: "Termed group",
      termsAndConditions: "Group rules",
    });
    const member = await createTestListing({
      groupId: group.id,
      maxAttendees: 5,
      name: "Termed member",
    });

    const ctx = await withSetting(
      { terms_and_conditions: "Site rules" },
      async () => getTicketContext([await ticketListing(member.id)], group),
    );
    expect(ctx.terms).toBe("Group rules");
  });

  test("falls back to the site's terms for a group that has none", async () => {
    const group = await createTestGroup({ name: "Untermed group" });
    const member = await createTestListing({
      groupId: group.id,
      maxAttendees: 5,
      name: "Untermed member",
    });

    const ctx = await withSetting(
      { terms_and_conditions: "Site rules" },
      async () => getTicketContext([await ticketListing(member.id)], group),
    );
    expect(ctx.terms).toBe("Site rules");
  });

  test("shows no terms at all when neither the group nor the site has any", async () => {
    const group = await createTestGroup({ name: "Termless group" });
    const member = await createTestListing({
      groupId: group.id,
      maxAttendees: 5,
      name: "Termless member",
    });

    const ctx = await withSetting({ terms_and_conditions: "" }, async () =>
      getTicketContext([await ticketListing(member.id)], group),
    );
    expect(ctx.terms).toBe("");
  });

  test("falls back to the site's terms on a page with no group", async () => {
    const listing = await createTestListing({
      maxAttendees: 5,
      name: "Plain page listing",
    });

    const ctx = await withSetting(
      { terms_and_conditions: "Site rules" },
      async () => getTicketContext([await ticketListing(listing.id)]),
    );
    expect(ctx.terms).toBe("Site rules");
  });

  test("shows no terms on a page with neither a group nor site terms", async () => {
    const listing = await createTestListing({
      maxAttendees: 5,
      name: "Termless page listing",
    });

    const ctx = await withSetting({ terms_and_conditions: "" }, async () =>
      getTicketContext([await ticketListing(listing.id)]),
    );
    expect(ctx.terms).toBe("");
  });
});
