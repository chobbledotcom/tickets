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

/** One terms case: what the group has (null means the page has no group at
 * all), what the site has, and which of the two the buyer should be shown. */
type TermsCase = {
  shows: string;
  groupTerms: string | null;
  siteTerms: string;
  expected: string;
};

const TERMS_CASES: TermsCase[] = [
  {
    expected: "Group rules",
    groupTerms: "Group rules",
    shows: "a group's own terms ahead of the site's",
    siteTerms: "Site rules",
  },
  {
    expected: "Site rules",
    groupTerms: "",
    shows: "the site's terms for a group that has none",
    siteTerms: "Site rules",
  },
  {
    expected: "",
    groupTerms: "",
    shows: "no terms when neither the group nor the site has any",
    siteTerms: "",
  },
  {
    expected: "Site rules",
    groupTerms: null,
    shows: "the site's terms on a page with no group",
    siteTerms: "Site rules",
  },
  {
    expected: "",
    groupTerms: null,
    shows: "no terms on a page with neither a group nor site terms",
    siteTerms: "",
  },
];

/** Build the listing (in a group, unless the case has none), set the site
 * terms, and report which terms its ticket page ends up showing. */
const termsShownFor = async (termsCase: TermsCase): Promise<string> => {
  const group =
    termsCase.groupTerms === null
      ? undefined
      : await createTestGroup({
          name: `Group for ${termsCase.shows}`,
          termsAndConditions: termsCase.groupTerms,
        });
  const listing = await createTestListing({
    ...(group ? { groupId: group.id } : {}),
    maxAttendees: 5,
    name: `Listing for ${termsCase.shows}`,
  });

  const ctx = await withSetting(
    { terms_and_conditions: termsCase.siteTerms },
    async () => getTicketContext([await ticketListing(listing.id)], group),
  );
  return ctx.terms;
};

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

  for (const termsCase of TERMS_CASES) {
    test(`shows ${termsCase.shows}`, async () => {
      expect(await termsShownFor(termsCase)).toBe(termsCase.expected);
    });
  }
});
