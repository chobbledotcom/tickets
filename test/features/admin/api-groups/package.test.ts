// JSON CRUD coverage for the group resource's package fields — is_package,
// hide_package_listings, package_members, and day_prices. Split from
// api-groups.test.ts so each file stays under the ~400-line target.
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getGroupPackagePrices, groups } from "#db/groups.ts";
import { getGroupDayPrices } from "#db/listing-prices.ts";
import { t } from "#i18n";
import {
  groupWithMember,
  packagedGroup,
  putGroup,
  soldPackage,
} from "#test/features/admin/groups/helpers.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { apiRequest } from "#test-utils/session.ts";

describeWithEnv("Admin API - Groups - package fields", { db: true }, () => {
  test("POST persists is_package and hide_package_listings", async () => {
    await assertJson(
      apiRequest("/api/admin/groups", {
        body: {
          hide_package_listings: true,
          is_package: true,
          name: "API Package",
        },
        method: "POST",
      }),
      201,
      (body) => {
        expect(body.group.is_package).toBe(true);
        expect(body.group.hide_package_listings).toBe(true);
      },
    );
  });

  test("GET hydrates even a single day price, and strips the blind index", async () => {
    const { group, listing } = await groupWithMember("SoloDay");
    await putGroup(group.id, {
      is_package: true,
      package_members: [
        {
          day_prices: { 2: 500 },
          listing_id: listing.id,
          price: null,
        },
      ],
    });
    await assertJson(
      apiRequest(`/api/admin/groups/${group.id}`),
      200,
      (body) => {
        expect(body.group.package_members).toEqual([
          {
            day_prices: { 2: 500 },
            listing_id: listing.id,
            price: null,
            quantity: 1,
          },
        ]);
        expect(Object.keys(body.group)).not.toContain("slug_index");
      },
    );
  });

  test("PUT rejects malformed package members (bad id, price, or quantity)", async () => {
    const { group, listing } = await groupWithMember("BadMembers");
    const cases: [Record<string, unknown>, string][] = [
      [{ listing_id: -1, price: 100 }, "listing_id"],
      [{ listing_id: listing.id, price: -5 }, "price"],
      [{ listing_id: listing.id, price: 100, quantity: 0 }, "quantity"],
    ];
    for (const [member, errorSubstring] of cases) {
      await assertJson(
        putGroup(group.id, { is_package: true, package_members: [member] }),
        400,
        (body) => {
          expect(body.error).toContain(errorSubstring);
        },
      );
    }
  });

  test("POST rejects package_members on create (assign listings first)", async () => {
    // A brand-new group has no listings, so member overrides can't attach —
    // creation must reject them rather than 201 an empty package.
    await assertJson(
      apiRequest("/api/admin/groups", {
        body: {
          is_package: true,
          name: "CreateWithMembers",
          package_members: [{ listing_id: 1, price: 100 }],
        },
        method: "POST",
      }),
      400,
      (body) => {
        expect(body.error).toContain("cannot be set on create");
      },
    );
  });

  test("POST rejects package_members that is not an array", async () => {
    await assertJson(
      apiRequest("/api/admin/groups", {
        body: {
          is_package: true,
          name: "BadCreate",
          package_members: {},
        },
        method: "POST",
      }),
      400,
      (body) => {
        expect(body.error).toBe("package_members must be an array");
      },
    );
  });

  test("PUT updates hide_package_listings", async () => {
    const group = await packagedGroup("HideUpd", 500);
    await assertJson(
      putGroup(group.id, { hide_package_listings: true, is_package: true }),
      200,
      (body) => {
        expect(body.group.hide_package_listings).toBe(true);
      },
    );
  });

  test("PUT sets is_package, package member prices and quantities", async () => {
    const { group, listing } = await groupWithMember("PUT Pkg");

    await assertJson(
      putGroup(group.id, {
        is_package: true,
        package_members: [{ listing_id: listing.id, price: 2500, quantity: 3 }],
      }),
      200,
      (body) => {
        expect(body.group.is_package).toBe(true);
      },
    );
    const rows = await getGroupPackagePrices(group.id);
    expect(rows).toEqual([
      {
        group_id: group.id,
        listing_id: listing.id,
        package_price: 2500,
        quantity: 3,
      },
    ]);
  });

  test("PUT defaults a member's quantity to 1 when omitted", async () => {
    const group = await packagedGroup("DefaultQty", 900);
    const rows = await getGroupPackagePrices(group.id);
    expect(rows[0]!.quantity).toBe(1);
  });

  test("GET hydrates package_members so config round-trips", async () => {
    const { group, listing } = await groupWithMember("RoundTrip");
    await putGroup(group.id, {
      is_package: true,
      package_members: [{ listing_id: listing.id, price: 0, quantity: 2 }],
    });
    await assertJson(
      apiRequest(`/api/admin/groups/${group.id}`),
      200,
      (body) => {
        expect(body.group.package_members).toEqual([
          { listing_id: listing.id, price: 0, quantity: 2 },
        ]);
      },
    );
  });

  test("PUT saves a member's day_prices and GET round-trips them", async () => {
    const { group, listing } = await groupWithMember("DayRoundTrip");
    await assertJson(
      putGroup(group.id, {
        is_package: true,
        package_members: [
          {
            day_prices: { "2": 1500, "3": 0 },
            listing_id: listing.id,
            price: null,
          },
        ],
      }),
      200,
      (body) => {
        expect(body.group.is_package).toBe(true);
      },
    );
    expect((await getGroupDayPrices(group.id)).get(listing.id)?.get(2)).toBe(
      1500,
    );
    expect((await getGroupDayPrices(group.id)).get(listing.id)?.get(3)).toBe(0);
    await assertJson(
      apiRequest(`/api/admin/groups/${group.id}`),
      200,
      (body) => {
        expect(body.group.package_members).toEqual([
          {
            day_prices: { "2": 1500, "3": 0 },
            listing_id: listing.id,
            price: null,
            quantity: 1,
          },
        ]);
      },
    );
  });

  test("PUT rejects malformed day_prices (shape, keys, and values)", async () => {
    const { group, listing } = await groupWithMember("BadDayPrices");
    const cases: [Record<string, unknown>, string][] = [
      [
        { day_prices: [1500], listing_id: listing.id, price: null },
        "package_members day_prices must be an object",
      ],
      [
        { day_prices: { "0": 1500 }, listing_id: listing.id, price: null },
        "package_members day_prices keys must be positive day counts",
      ],
      [
        { day_prices: { "2e0": 1500 }, listing_id: listing.id, price: null },
        "package_members day_prices keys must be positive day counts",
      ],
      [
        { day_prices: { "2": -1 }, listing_id: listing.id, price: null },
        "package_members day_prices values must be non-negative integers",
      ],
    ];
    for (const [member, error] of cases) {
      await assertJson(
        putGroup(group.id, { is_package: true, package_members: [member] }),
        400,
        (body) => {
          expect(body.error).toBe(error);
        },
      );
    }
  });

  test("GET omits package_members for a non-package group", async () => {
    const group = await createTestGroup({ name: "Plain" });
    await assertJson(
      apiRequest(`/api/admin/groups/${group.id}`),
      200,
      (body) => {
        expect(body.group.package_members).toBeUndefined();
      },
    );
  });

  test("PUT without package_members leaves existing overrides untouched", async () => {
    const group = await packagedGroup("Keep", 800);

    // A name-only update must not wipe the saved override.
    await apiRequest(`/api/admin/groups/${group.id}`, {
      body: { name: "Keep Renamed" },
      method: "PUT",
    });
    const prices = await getGroupPackagePrices(group.id);
    expect(prices[0]!.package_price).toBe(800);
  });

  test("PUT is_package:false clears overrides", async () => {
    const group = await packagedGroup("Drop", 400);

    await apiRequest(`/api/admin/groups/${group.id}`, {
      body: { is_package: false },
      method: "PUT",
    });
    const prices = await getGroupPackagePrices(group.id);
    expect(prices[0]!.package_price).toBeNull();
  });

  test("PUT rejects a malformed package_members entry without wiping overrides", async () => {
    const group = await packagedGroup("FailClosed", 600);
    await assertJson(
      apiRequest(`/api/admin/groups/${group.id}`, {
        body: {
          is_package: true,
          package_members: [null],
        },
        method: "PUT",
      }),
      400,
      (body) => {
        expect(body.error).toContain("package_members");
      },
    );
    // The existing override survives the rejected request.
    const prices = await getGroupPackagePrices(group.id);
    expect(prices[0]!.package_price).toBe(600);
  });

  test("PUT rejects is_package on an incompatible group", async () => {
    const group = await createTestGroup({ name: "BadPkg" });
    await createTestListing({ canPayMore: true, groupId: group.id });

    await assertJson(
      apiRequest(`/api/admin/groups/${group.id}`, {
        body: { is_package: true },
        method: "PUT",
      }),
      400,
      (body) => {
        expect(body.error).toContain("Packages cannot contain");
      },
    );
  });

  test("PUT rejects un-packaging a hidden package with sold tickets", async () => {
    const group = await soldPackage("Hidden sold unpackage", true);

    await assertJson(
      apiRequest(`/api/admin/groups/${group.id}`, {
        body: { is_package: false },
        method: "PUT",
      }),
      400,
      (body) => {
        expect(body.error).toBe(t("error.sold_hidden_package"));
      },
    );
    const refreshed = await groups.cache.getAll();
    expect(refreshed.find((g) => g.id === group.id)?.is_package).toBe(true);
  });
});
