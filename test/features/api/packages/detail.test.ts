import { expect } from "@std/expect";
import { beforeEach, it as test } from "@std/testing/bdd";
import { listingChildren } from "#db/listing-parents.ts";
import { settings } from "#db/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { apiGet } from "#test-utils/parents.ts";
import {
  apiBookPackage,
  bookingRows,
  customisablePackage,
  fixedPackage,
  packageCap,
  twoParentPackage,
  withAddonGetPackage,
} from "./helpers.ts";

describeWithEnv("API package detail", { db: true }, () => {
  beforeEach(async () => {
    await settings.update.showPublicApi(true);
  });

  test("GET returns 404 for an unknown slug and for a non-package group", async () => {
    const missing = await apiGet("/api/packages/nope");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Package not found" });
    const regular = await createTestGroup({ name: "Plain", slug: "plain-g" });
    await createTestListing({ groupId: regular.id, name: "Plain Member" });
    expect((await apiGet(`/api/packages/${regular.slug}`)).status).toBe(404);
  });

  test("GET reports a fixed bundle's price, cap, and members", async () => {
    const { group } = await fixedPackage("Fixed Kit", "fixed-kit");
    const response = await apiGet(`/api/packages/${group.slug}`);
    expect(response.status).toBe(200);
    const { package: pkg } = await response.json();
    // One bundle = A's own 1000 × 2 + B's 500 override.
    expect(pkg.priceMinor).toBe(2500);
    // A takes 2 units per package from 10 spots → 5 whole bundles fit.
    expect(pkg.maxPurchasable).toBe(5);
    // The merged member field setting, so a client knows what to submit.
    expect(pkg.fields).toBe("email");
    expect(pkg.availableDates).toBeUndefined();
    expect(pkg.dayCounts).toBeUndefined();
    expect(pkg.members).toEqual([
      { name: "Fixed Kit A", quantity: 2, slug: expect.any(String) },
      { name: "Fixed Kit B", quantity: 1, slug: expect.any(String) },
    ]);
  });

  test("GET prices each offered day count for a customisable bundle, per-day overrides included", async () => {
    const { group } = await customisablePackage("Flex Kit", "flex-api-kit");
    const response = await apiGet(`/api/packages/${group.slug}`);
    expect(response.status).toBe(200);
    const { package: pkg } = await response.json();
    // The boat's 2-day span is repriced to 1500 INSIDE this package: 2 days
    // total 1500 + 900, never the un-overridden 2700 or base × days.
    expect(pkg.dayCounts).toEqual([
      { days: 1, priceMinor: 1500 },
      { days: 2, priceMinor: 2400 },
    ]);
    expect(pkg.priceMinor).toBeUndefined();
    expect(Array.isArray(pkg.availableDates)).toBe(true);
    expect(pkg.availableDates.length).toBeGreaterThan(0);
  });

  test("GET lists a parent member's children and hides a hidden package's members", async () => {
    const { a, group } = await fixedPackage("Parent Kit", "parent-kit");
    const child = await createTestListing({
      maxAttendees: 10,
      maxQuantity: 10,
      name: "Kit Addon",
      unitPrice: 300,
    });
    await listingChildren.setIds(a.id, [child.id]);
    const { package: pkg } = await (
      await apiGet(`/api/packages/${group.slug}`)
    ).json();
    const parentMember = pkg.members.find(
      (m: { name: string }) => m.name === "Parent Kit A",
    );
    expect(parentMember.children).toHaveLength(1);
    expect(parentMember.children[0].name).toBe("Kit Addon");

    const { groups } = await import("#db/groups.ts");
    await groups.table.update(group.id, { hidePackageListings: true });
    const { package: hidden } = await (
      await apiGet(`/api/packages/${group.slug}`)
    ).json();
    expect(hidden.members).toBeUndefined();
    expect(hidden.name).toBe("Parent Kit");
  });

  test("GET gives a daily child its available dates", async () => {
    const { boat, group } = await customisablePackage(
      "Daily child kit",
      "daily-child-kit",
    );
    const child = await createDailyTestListing({ name: "Daily child" });
    await listingChildren.setIds(boat.id, [child.id]);

    const { package: pkg } = await (
      await apiGet(`/api/packages/${group.slug}`)
    ).json();
    const parentMember = pkg.members.find(
      (member: { slug: string }) => member.slug === boat.slug,
    );
    const [publicChild] = parentMember.children;

    expect(publicChild.name).toBe("Daily child");
    expect(publicChild.availableDates.length).toBeGreaterThan(0);
  });

  test("GET includes the unavoidable child charge in the bundle price", async () => {
    // The fold books children totalling each parent member's quantity (a sole
    // bookable child is auto-selected), so the advertised bundle total must
    // carry each parent member's cheapest bookable child: A's own 1000 × 2
    // plus the 300 add-on × 2 plus B's 500 override.
    const { a, group } = await fixedPackage("Priced Kit", "priced-kit");
    const cheap = await createTestListing({
      maxAttendees: 10,
      maxQuantity: 10,
      name: "Cheap Addon",
      unitPrice: 300,
    });
    const dear = await createTestListing({
      maxAttendees: 10,
      maxQuantity: 10,
      name: "Dear Addon",
      unitPrice: 700,
    });
    await listingChildren.setIds(a.id, [cheap.id, dear.id]);
    const { package: pkg } = await (
      await apiGet(`/api/packages/${group.slug}`)
    ).json();
    expect(pkg.priceMinor).toBe(3100);

    // A child a buyer can't choose must not price the bundle: with the cheap
    // add-on deactivated, the dear one is the cheapest bookable child.
    const { deactivateTestListing } = await import(
      "#test-utils/db-helpers/listings.ts"
    );
    await deactivateTestListing(cheap.id);
    const { package: repriced } = await (
      await apiGet(`/api/packages/${group.slug}`)
    ).json();
    expect(repriced.priceMinor).toBe(3900);
  });

  test("GET merges a member's child fields into the package fields", async () => {
    // The package reports every field that its own booking path requires.
    const { a, group } = await fixedPackage("Hidden Fields", "hidden-fields");
    const child = await createTestListing({
      fields: "email,phone",
      maxAttendees: 10,
      maxQuantity: 10,
      name: "Fields Addon",
      unitPrice: 0,
    });
    await listingChildren.setIds(a.id, [child.id]);
    const { groups } = await import("#db/groups.ts");
    await groups.table.update(group.id, { hidePackageListings: true });

    const { package: pkg } = await (
      await apiGet(`/api/packages/${group.slug}`)
    ).json();
    expect(pkg.members).toBeUndefined();
    expect(pkg.fields).toBe("email,phone");
  });

  test("GET drops day counts no member's required child can serve", async () => {
    // The flex members share spans {1,2}, but the boat's only add-on is a
    // fixed 2-day daily child — a 1-day bundle could never fold, so it must
    // not be advertised (the web selector applies the same constraint).
    const { boat, group } = await customisablePackage("Span Gate", "span-gate");
    const child = await createTestListing({
      durationDays: 2,
      listingType: "daily",
      maxAttendees: 10,
      minimumDaysBefore: 0,
      name: "Two Day Addon",
      unitPrice: 200,
    });
    await listingChildren.setIds(boat.id, [child.id]);

    const { package: pkg } = await (
      await apiGet(`/api/packages/${group.slug}`)
    ).json();
    // 2400 for the members plus the boat's unavoidable 200 add-on charge.
    expect(pkg.dayCounts).toEqual([{ days: 2, priceMinor: 2600 }]);
  });

  test("a member's required-child capacity bounds the package cap and the booking clamp", async () => {
    // The member has 10 spots, but its add-ons can only serve 2 units — a
    // 3-bundle order could never fold, so neither GET nor POST may offer it.
    const group = await createTestGroup({
      isPackage: true,
      name: "Tight Kit",
      slug: "tight-kit",
    });
    const member = await createTestListing({
      groupId: group.id,
      maxAttendees: 10,
      maxQuantity: 10,
      name: "Tight Kit Member",
      unitPrice: 500,
    });
    const child = await createTestListing({
      maxAttendees: 2,
      maxQuantity: 2,
      name: "Tight Kit Addon",
      unitPrice: 100,
    });
    const pkg = await withAddonGetPackage(member.id, child.id, group.slug);
    expect(pkg.maxPurchasable).toBe(2);

    const { body, response } = await apiBookPackage(group.slug, {
      children: [{ parent: member.slug, quantity: 2, slug: child.slug }],
      quantity: 99,
    });
    expect(response.status).toBe(200);
    // 2 bundles × (500 member + 100 add-on).
    expect(body.booking!.amountOwed).toBe(1200);
    expect((await bookingRows(member.id))[0]!.quantity).toBe(2);
    expect((await bookingRows(child.id))[0]!.quantity).toBe(2);
  });

  test("a child's capped group bounds the API cap like the web page", async () => {
    // The add-on has plenty of own capacity but sits in a capped group with 1
    // spot: the API's cap must see that shared pool exactly as the web render
    // does (the group maps cover members AND children), so it advertises 1 —
    // never a count checkout would reject.
    const group = await createTestGroup({
      isPackage: true,
      name: "Pool Kit",
      slug: "pool-kit",
    });
    const member = await createTestListing({
      groupId: group.id,
      maxAttendees: 10,
      maxQuantity: 10,
      name: "Pool Kit Member",
      unitPrice: 500,
    });
    const childPool = await createTestGroup({
      maxAttendees: 1,
      name: "Addon Pool",
      slug: "addon-pool",
    });
    const child = await createTestListing({
      groupId: childPool.id,
      maxAttendees: 10,
      maxQuantity: 10,
      name: "Pool Kit Addon",
      unitPrice: 100,
    });
    const pkg = await withAddonGetPackage(member.id, child.id, group.slug);
    expect(pkg.maxPurchasable).toBe(1);
  });

  test("package dates are constrained by a daily member's required children", async () => {
    // A package books every member together, so a date the member's sole
    // required add-on can't serve (it is bookable only on Mondays) must not
    // be advertised — the fold would reject it at submit.
    const group = await createTestGroup({
      isPackage: true,
      name: "Date Gate",
      slug: "date-gate",
    });
    // TWO members, so the single-listing-page union can't be what constrains
    // the dates — the package-wide member walk must.
    const member = await createDailyTestListing({
      groupId: group.id,
      name: "Date Gate Boat",
      unitPrice: 500,
    });
    await createDailyTestListing({
      groupId: group.id,
      name: "Date Gate Hut",
      unitPrice: 300,
    });
    const child = await createDailyTestListing({
      bookableDays: ["Monday"],
      name: "Monday Addon",
      unitPrice: 100,
    });
    await listingChildren.setIds(member.id, [child.id]);
    const { package: pkg } = await (
      await apiGet(`/api/packages/${group.slug}`)
    ).json();
    expect(pkg.availableDates.length).toBeGreaterThan(0);
    for (const date of pkg.availableDates) {
      expect(new Date(`${date}T00:00:00Z`).getUTCDay()).toBe(1);
    }
  });

  test("GET prices a two-day span with only its bookable children", async () => {
    // A child alternative that cannot serve the chosen span is not free —
    // its missing day price must not drag the bundle minimum down to 500.
    // The fold prices the sole span-compatible child: 500 + 2000 = 2500.
    const group = await createTestGroup({
      isPackage: true,
      name: "Span Price",
      slug: "span-price",
    });
    const member = await createDailyTestListing({
      customisableDays: true,
      dayPrices: { 1: 500, 2: 500 },
      durationDays: 2,
      groupId: group.id,
      maxAttendees: 10,
      maxQuantity: 10,
      name: "Span Price Member",
    });
    const oneDay = await createDailyTestListing({
      customisableDays: true,
      dayPrices: { 1: 100 },
      durationDays: 1,
      name: "One Day Addon",
    });
    const twoDays = await createDailyTestListing({
      customisableDays: true,
      dayPrices: { 2: 2000 },
      durationDays: 2,
      name: "Two Day Addon",
    });
    await listingChildren.setIds(member.id, [oneDay.id, twoDays.id]);

    const { package: pkg } = await (
      await apiGet(`/api/packages/${group.slug}`)
    ).json();
    expect(
      pkg.dayCounts.find((option: { days: number }) => option.days === 2)
        .priceMinor,
    ).toBe(2500);
  });

  test("two parents sharing one sole add-on aggregate their demand in the cap", async () => {
    // One bundle folds BOTH members' units into the same sole add-on, so its
    // 2 spots serve exactly 1 bundle — the per-member caps each read 2 and
    // their minimum would advertise 2, a count the fold rejects.
    const { group, m1, m2 } = await twoParentPackage("Drain Kit", "drain-kit");
    const addon = await createTestListing({
      maxAttendees: 2,
      maxQuantity: 10,
      name: "Shared Addon",
      unitPrice: 100,
    });
    await listingChildren.setIds(m1.id, [addon.id]);
    await listingChildren.setIds(m2.id, [addon.id]);
    expect(await packageCap(group.slug)).toBe(1);
  });

  test("two parents whose add-on choices all draw one capped pool aggregate demand", async () => {
    // Each member offers a CHOICE of two add-ons, but every choice sits in
    // the same capped group (2 spots): one bundle folds 2 child units into
    // that pool whichever add-ons the buyer picks, so only 1 bundle fits —
    // the per-member caps each read 2.
    const { group, m1, m2 } = await twoParentPackage(
      "Pool Drain",
      "pool-drain",
    );
    const pool = await createTestGroup({
      maxAttendees: 2,
      name: "Choice Pool",
      slug: "choice-pool",
    });
    const addonOpts = {
      groupId: pool.id,
      maxAttendees: 10,
      maxQuantity: 10,
      unitPrice: 100,
    };
    const addons = [];
    for (const name of ["Choice 1", "Choice 2", "Choice 3", "Choice 4"]) {
      addons.push(await createTestListing({ ...addonOpts, name }));
    }
    await listingChildren.setIds(m1.id, [addons[0]!.id, addons[1]!.id]);
    await listingChildren.setIds(m2.id, [addons[2]!.id, addons[3]!.id]);
    expect(await packageCap(group.slug)).toBe(1);
  });
});
