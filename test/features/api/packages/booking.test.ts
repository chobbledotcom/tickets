import { expect } from "@std/expect";
import { beforeEach, it as test } from "@std/testing/bdd";
import { groups, setGroupPackageMembers } from "#db/groups.ts";
import { settings } from "#db/settings.ts";
import { MAX_BOOKING_ATTEMPTS } from "#shared/limits.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { apiGet } from "#test-utils/parents.ts";
import { statementSql, wrapDbClient } from "#test-utils/record-queries.ts";
import {
  apiBookPackage,
  bookingRows,
  customisablePackage,
  expectPackageNeedsEmail,
  fixedPackage,
  twoChildAddons,
} from "./helpers.ts";

describeWithEnv("API package booking", { db: true }, () => {
  beforeEach(async () => {
    await settings.update.showPublicApi(true);
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

  test("POST keeps a package fact read failure after a free booking", async () => {
    const group = await createTestGroup({
      isPackage: true,
      name: "Free notify kit",
      slug: "free-notify-kit",
    });
    const member = await createTestListing({
      groupId: group.id,
      maxAttendees: 10,
      maxQuantity: 10,
      name: "Free notify member",
      unitPrice: 0,
      webhookUrl: "https://example.com/registration",
    });
    await setGroupPackageMembers(group.id, [
      { listingId: member.id, price: null },
    ]);
    let packageFactFailureRan = false;
    const restoreDb = wrapDbClient({
      batch: () => {},
      execute: (statement) => {
        if (
          !statementSql(statement).includes("groupRecord.hide_package_listings")
        ) {
          return null;
        }
        packageFactFailureRan = true;
        return Promise.reject(new Error("package facts unavailable"));
      },
    });

    let result: Awaited<ReturnType<typeof apiBookPackage>>;
    try {
      result = await apiBookPackage(group.slug);
    } finally {
      restoreDb();
    }

    expect(packageFactFailureRan).toBe(true);
    expect(result.response.status).toBe(200);
    expect(await bookingRows(member.id)).toHaveLength(1);
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
    await expectPackageNeedsEmail(group.slug);
  });

  test("POST requires email when a package costs money", async () => {
    const group = await createTestGroup({
      isPackage: true,
      name: "Paid field kit",
      slug: "paid-field-kit",
    });
    const member = await createTestListing({
      fields: "",
      groupId: group.id,
      name: "Paid field member",
      unitPrice: 100,
    });
    await setGroupPackageMembers(group.id, [
      { listingId: member.id, price: 100 },
    ]);
    await settings.update.paymentProvider("square");

    await expectPackageNeedsEmail(group.slug);
  });

  for (const concealed of [false, true]) {
    test(`POST names the selected package path in a child-total error (${concealed})`, async () => {
      const { a, group } = await fixedPackage("Mix Kit", "mix-kit");
      const { child } = await twoChildAddons(a, "Mix Kit");
      await groups.table.update(group.id, { hidePackageListings: concealed });

      // Member A books 2 units per package; a single chosen add-on undershoots.
      const { body, response } = await apiBookPackage(group.slug, {
        children: [{ parent: a.slug, quantity: 1, slug: child.slug }],
      });
      expect(response.status).toBe(400);
      expect(body.error).toBe(
        `Choose 1 more add-on for ${concealed ? group.name : a.name}.`,
      );
      expect(await bookingRows(a.id)).toHaveLength(0);
    });
  }

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
    const { child, childB } = await twoChildAddons(a, "Child Kit");

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
    const { setupStripe } = await import("#test-utils/settings.ts");
    const { stub } = await import("@std/testing/mock");
    const { stripePaymentProvider } = await import(
      "#shared/stripe-provider.ts"
    );
    await setupStripe();

    const { group } = await fixedPackage("Paid Kit", "paid-kit");
    const hidden = await fixedPackage("Secret Kit", "secret-kit");
    const { child } = await twoChildAddons(hidden.a, "Secret Kit");
    await groups.table.update(hidden.group.id, { hidePackageListings: true });

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

      const concealed = await apiBookPackage(hidden.group.slug, {
        children: [{ parent: hidden.a.slug, quantity: 2, slug: child.slug }],
      });
      expect(concealed.response.status).toBe(200);
      // A hidden package's hosted checkout must never name its members.
      expect(intents[1]!.items.map((i) => i.name)).toEqual([
        "Secret Kit",
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
