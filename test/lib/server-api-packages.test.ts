import { expect } from "@std/expect";
import { beforeEach, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { queryAll } from "#shared/db/client.ts";
import { setGroupPackageMembers } from "#shared/db/groups.ts";
import { listingChildren } from "#shared/db/listing-parents.ts";
import { settings } from "#shared/db/settings.ts";
import { MAX_BOOKING_ATTEMPTS } from "#shared/limits.ts";
import {
  createDailyTestListing,
  createTestGroup,
  createTestListing,
  describeWithEnv,
} from "#test-utils";
import { createFlexPackage } from "#test-utils/packages.ts";
import { apiGet } from "#test-utils/parents.ts";

/** POST /api/packages/:slug/book with a minimal valid contact payload merged
 * with any extra body fields (quantity, date, dayCount, children). */
const apiBookPackage = async (
  slug: string,
  extra: Record<string, unknown> = {},
  rawBody?: string,
): Promise<{
  response: Response;
  body: {
    booking?: {
      amountOwed: number;
      checkoutUrl?: string;
      ticketToken: string;
    };
    error?: string;
  };
}> => {
  const response = await handleRequest(
    new Request(`http://localhost/api/packages/${slug}/book`, {
      body:
        rawBody ??
        JSON.stringify({ email: "pkg@test.com", name: "Pkg Buyer", ...extra }),
      headers: { "content-type": "application/json", host: "localhost" },
      method: "POST",
    }),
  );
  return { body: await response.json(), response };
};

/** The REAL booking rows for a listing (refund placeholders excluded). */
const bookingRows = (
  listingId: number,
): Promise<
  { quantity: number; package_group_id: number; parent_listing_id: number }[]
> =>
  queryAll(
    `SELECT quantity, package_group_id, parent_listing_id FROM listing_attendees
      WHERE listing_id = ? AND quantity > 0 ORDER BY id DESC`,
    [listingId],
  );

/** A fixed-price two-member package: member A at its own 1000 ×2 per package,
 * member B overridden to 500 — one bundle totals 2500. */
const fixedPackage = async (name: string, slug: string) => {
  const group = await createTestGroup({ isPackage: true, name, slug });
  const a = await createTestListing({
    groupId: group.id,
    maxAttendees: 10,
    maxQuantity: 10,
    name: `${name} A`,
    unitPrice: 1000,
  });
  const b = await createTestListing({
    groupId: group.id,
    maxAttendees: 10,
    maxQuantity: 10,
    name: `${name} B`,
    unitPrice: 800,
  });
  await setGroupPackageMembers(group.id, [
    { listingId: a.id, price: null, quantity: 2 },
    { listingId: b.id, price: 500 },
  ]);
  return { a, b, group };
};

/** A customisable dated package via the shared fixture, with the boat's 2-day
 * span repriced to 1500 in this package — 1 day totals 1500, 2 days 2400. */
const customisablePackage = (name: string, slug: string) =>
  createFlexPackage(name, slug, { dayPrices: { 2: 1500 }, price: null });

/** Attach `child` as the member's sole add-on and fetch the package detail. */
const withAddonGetPackage = async (
  memberId: number,
  childId: number,
  slug: string,
  // deno-lint-ignore no-explicit-any
): Promise<any> => {
  await listingChildren.setIds(memberId, [childId]);
  return (await (await apiGet(`/api/packages/${slug}`)).json()).package;
};

/** A package of two identical parent-capable members, for the cross-parent
 * child-demand cases (each member gets its add-ons attached by the test). */
const twoParentPackage = async (name: string, slug: string) => {
  const group = await createTestGroup({ isPackage: true, name, slug });
  const memberOpts = {
    groupId: group.id,
    maxAttendees: 10,
    maxQuantity: 10,
    unitPrice: 500,
  };
  const m1 = await createTestListing({ ...memberOpts, name: `${name} A` });
  const m2 = await createTestListing({ ...memberOpts, name: `${name} B` });
  return { group, m1, m2 };
};

/** The package detail's advertised whole-bundle cap. */
const packageCap = async (slug: string): Promise<number> =>
  (await (await apiGet(`/api/packages/${slug}`)).json()).package
    .maxPurchasable as number;

describeWithEnv("public API packages", { db: true }, () => {
  beforeEach(async () => {
    await settings.update.showPublicApi(true);
  });

  test("GET returns 404 for an unknown slug and for a non-package group", async () => {
    expect((await apiGet("/api/packages/nope")).status).toBe(404);
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

    const { groupsTable } = await import("#shared/db/groups.ts");
    await groupsTable.update(group.id, { hidePackageListings: true });
    const { package: hidden } = await (
      await apiGet(`/api/packages/${group.slug}`)
    ).json();
    expect(hidden.members).toBeUndefined();
    expect(hidden.name).toBe("Parent Kit");
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
    const { deactivateTestListing } = await import("#test-utils");
    await deactivateTestListing(cheap.id);
    const { package: repriced } = await (
      await apiGet(`/api/packages/${group.slug}`)
    ).json();
    expect(repriced.priceMinor).toBe(3900);
  });

  test("GET merges a member's child fields into the package fields", async () => {
    // A hidden package's members 404 through the listing API, so the bundle's
    // field requirement — including what a chosen add-on can demand — must be
    // discoverable at package level.
    const { a, group } = await fixedPackage("Hidden Fields", "hidden-fields");
    const child = await createTestListing({
      fields: "email,phone",
      maxAttendees: 10,
      maxQuantity: 10,
      name: "Fields Addon",
      unitPrice: 0,
    });
    await listingChildren.setIds(a.id, [child.id]);
    const { groupsTable } = await import("#shared/db/groups.ts");
    await groupsTable.update(group.id, { hidePackageListings: true });

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

  test("POST books whole bundles, clamped to the cap, stamping the group", async () => {
    const { a, b, group } = await fixedPackage("Book Kit", "book-kit");
    // 99 requested, but member A's 10 spots ÷ 2 per package cap it at 5.
    const { body, response } = await apiBookPackage(group.slug, {
      quantity: 99,
    });
    expect(response.status).toBe(200);
    expect(body.booking!.ticketToken).toBeDefined();
    // Provider-less paid booking owes the full value: 2500 × 5 bundles.
    expect(body.booking!.amountOwed).toBe(12_500);
    const aRow = (await bookingRows(a.id))[0]!;
    const bRow = (await bookingRows(b.id))[0]!;
    expect(aRow.quantity).toBe(10);
    expect(bRow.quantity).toBe(5);
    expect(Number(aRow.package_group_id)).toBe(group.id);
    expect(Number(bRow.package_group_id)).toBe(group.id);
  });

  test("POST rejects an explicit quantity of 0 and malformed JSON", async () => {
    const { group } = await fixedPackage("Zero Kit", "zero-kit");
    const zero = await apiBookPackage(group.slug, { quantity: 0 });
    expect(zero.response.status).toBe(400);
    const bad = await apiBookPackage(group.slug, {}, "not json");
    expect(bad.response.status).toBe(400);
  });

  test("POST treats a malformed quantity as 1 bundle", async () => {
    const { a, b, group } = await fixedPackage("Default Kit", "default-kit");
    const { body, response } = await apiBookPackage(group.slug, {
      quantity: "lots",
    });
    expect(response.status).toBe(200);
    expect(body.booking!.amountOwed).toBe(2500);
    expect((await bookingRows(a.id))[0]!.quantity).toBe(2);
    expect((await bookingRows(b.id))[0]!.quantity).toBe(1);
  });

  test("POST rejects a booking missing the required contact fields", async () => {
    const { group } = await fixedPackage("Fields Kit", "fields-kit");
    const { body, response } = await apiBookPackage(
      group.slug,
      {},
      JSON.stringify({ name: "No Email" }),
    );
    expect(response.status).toBe(400);
    expect(body.error).toMatch(/email/i);
  });

  test("POST rejects a child mix that does not total the member's units", async () => {
    const { a, group } = await fixedPackage("Mix Kit", "mix-kit");
    const child = await createTestListing({
      maxAttendees: 10,
      maxQuantity: 10,
      name: "Mix Kit Addon",
      unitPrice: 300,
    });
    const childB = await createTestListing({
      maxAttendees: 10,
      maxQuantity: 10,
      name: "Mix Kit Addon B",
      unitPrice: 400,
    });
    await listingChildren.setIds(a.id, [child.id, childB.id]);

    // Member A books 2 units per package; a single chosen add-on undershoots.
    const { body, response } = await apiBookPackage(group.slug, {
      children: [{ parent: a.slug, quantity: 1, slug: child.slug }],
    });
    expect(response.status).toBe(400);
    expect(body.error).toBeDefined();
    expect(await bookingRows(a.id)).toHaveLength(0);
  });

  test("POST returns 404 for an unknown package", async () => {
    const { response } = await apiBookPackage("nope");
    expect(response.status).toBe(404);
  });

  test("POST requires a valid date for a dated bundle and a day count for a customisable one", async () => {
    const { group } = await customisablePackage("Gate Kit", "gate-kit");
    const noDate = await apiBookPackage(group.slug, { dayCount: 2 });
    expect(noDate.response.status).toBe(400);
    expect(noDate.body.error).toContain("valid date");

    const { package: pkg } = await (
      await apiGet(`/api/packages/${group.slug}`)
    ).json();
    const date = pkg.availableDates[0];
    const noDays = await apiBookPackage(group.slug, { date });
    expect(noDays.response.status).toBe(400);
    expect(noDays.body.error).toContain("days");
  });

  test("POST books a customisable bundle at the chosen span's package prices", async () => {
    const { boat, group, hut } = await customisablePackage(
      "Span Kit",
      "span-kit",
    );
    const { package: pkg } = await (
      await apiGet(`/api/packages/${group.slug}`)
    ).json();
    const date = pkg.availableDates[0];
    const { body, response } = await apiBookPackage(group.slug, {
      date,
      dayCount: 2,
    });
    expect(response.status).toBe(200);
    // The boat's per-day override (1500) + the hut's own 2-day price (900).
    expect(body.booking!.amountOwed).toBe(2400);
    expect((await bookingRows(boat.id))[0]!.quantity).toBe(1);
    expect((await bookingRows(hut.id))[0]!.quantity).toBe(1);
  });

  test("POST folds a member's chosen child and rejects unknown or malformed selections", async () => {
    const { a, group } = await fixedPackage("Child Kit", "child-kit");
    const child = await createTestListing({
      maxAttendees: 10,
      maxQuantity: 10,
      name: "Child Kit Addon",
      unitPrice: 300,
    });
    const childB = await createTestListing({
      maxAttendees: 10,
      maxQuantity: 10,
      name: "Child Kit Addon B",
      unitPrice: 400,
    });
    await listingChildren.setIds(a.id, [child.id, childB.id]);

    // Member A books 2 units per package, so its child mix must total 2.
    const { body, response } = await apiBookPackage(group.slug, {
      children: [
        { parent: a.slug, quantity: 1, slug: child.slug },
        { parent: a.slug, quantity: 1, slug: childB.slug },
      ],
    });
    expect(response.status).toBe(200);
    // 2500 bundle + 300 + 400 chosen add-ons, exactly once.
    expect(body.booking!.amountOwed).toBe(3200);
    const childRow = (await bookingRows(child.id))[0]!;
    expect(Number(childRow.parent_listing_id)).toBe(a.id);

    const unknown = await apiBookPackage(group.slug, {
      children: [{ parent: "not-a-member", quantity: 1, slug: child.slug }],
    });
    expect(unknown.response.status).toBe(400);
    expect(unknown.body.error).toContain("not a member");

    const malformed = await apiBookPackage(group.slug, {
      children: [{ quantity: 1, slug: child.slug }],
    });
    expect(malformed.response.status).toBe(400);
    expect(malformed.body.error).toContain("parent");

    // A garbage customPrice is a schema parse failure — never NaN stored as a
    // price.
    const badPrice = await apiBookPackage(group.slug, {
      children: [
        { customPrice: "x", parent: a.slug, quantity: 1, slug: child.slug },
      ],
    });
    expect(badPrice.response.status).toBe(400);

    // A member that gates no children accepts no child selections either.
    const { b } = await fixedPackage("Childless Kit", "childless-kit");
    const childless = await apiBookPackage("childless-kit", {
      children: [{ parent: b.slug, quantity: 1, slug: child.slug }],
    });
    expect(childless.response.status).toBe(400);
    expect(childless.body.error).toContain("not a child");
  });

  test("POST creates a paid checkout carrying the package id; a hidden package's items keep its name", async () => {
    const { setupStripe } = await import("#test-utils");
    const { stub } = await import("@std/testing/mock");
    const { stripePaymentProvider } = await import(
      "#shared/stripe-provider.ts"
    );
    await setupStripe();

    const { group } = await fixedPackage("Paid Kit", "paid-kit");
    const hidden = await fixedPackage("Secret Kit", "secret-kit");
    const { groupsTable } = await import("#shared/db/groups.ts");
    await groupsTable.update(hidden.group.id, { hidePackageListings: true });

    const intents: import("#shared/payments.ts").CheckoutIntent[] = [];
    const mockCreate = stub(
      stripePaymentProvider,
      "createCheckoutSession",
      (intent: import("#shared/payments.ts").CheckoutIntent) => {
        intents.push(intent);
        return Promise.resolve({
          checkoutUrl: "https://stripe.test/checkout",
          sessionId: `cs_pkg_${intents.length}`,
        });
      },
    );

    try {
      const visible = await apiBookPackage(group.slug);
      expect(visible.response.status).toBe(200);
      expect(visible.body.booking!.checkoutUrl).toContain("stripe.test");
      // The package id rides per line now: every member item carries it.
      expect(intents[0]!.items.map((i) => i.packageGroupId)).toEqual([
        group.id,
        group.id,
      ]);
      expect(intents[0]!.items.map((i) => i.name)).toEqual([
        "Paid Kit A",
        "Paid Kit B",
      ]);

      const concealed = await apiBookPackage(hidden.group.slug);
      expect(concealed.response.status).toBe(200);
      // A hidden package's hosted checkout must never name its members.
      expect(intents[1]!.items.map((i) => i.name)).toEqual([
        "Secret Kit",
        "Secret Kit",
      ]);
    } finally {
      mockCreate.restore();
    }
  });

  test("POST rate-limits bookings after too many attempts from one IP", async () => {
    // Roomy capacity so the bundle stays bookable for every pre-limit attempt.
    const group = await createTestGroup({
      isPackage: true,
      name: "Limit Kit",
      slug: "limit-kit",
    });
    await createTestListing({
      groupId: group.id,
      maxAttendees: 100,
      maxQuantity: 100,
      name: "Limit Kit Member",
      unitPrice: 100,
    });
    // All test requests share the "direct" fallback IP, so the per-IP counter
    // fills up. The first MAX_BOOKING_ATTEMPTS succeed; the next is blocked.
    for (let i = 0; i < MAX_BOOKING_ATTEMPTS; i++) {
      const { response } = await apiBookPackage(group.slug, {
        email: `limit${i}@test.com`,
        name: `Limit ${i}`,
      });
      expect(response.status).toBe(200);
    }
    const { body, response } = await apiBookPackage(group.slug, {
      email: "blocked@test.com",
      name: "Blocked",
    });
    expect(response.status).toBe(429);
    expect(body.error).toMatch(/too many/i);
  });
});
