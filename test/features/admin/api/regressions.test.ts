import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { listingGroups } from "#db/groups/table.ts";
import { listingChildren } from "#db/listing-parents.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { t } from "#i18n";
import { bodyToCreateInput } from "#routes/admin/api-listing-body.ts";
import { sitePlanMemberError } from "#shared/package-membership.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withEnv } from "#test-utils/env.ts";
import { rescuingPageSetup } from "#test-utils/listing-parents/helpers.ts";
import { postChildren } from "#test-utils/parents.ts";
import { apiRequest } from "#test-utils/session.ts";

const expectListingApiError = (
  path: string,
  method: string,
  body: Record<string, unknown>,
  error: string,
): Promise<{ error: string }> =>
  assertJson<{ error: string }>(
    apiRequest(path, { body, method }),
    400,
    (response) => {
      expect(response.error).toBe(error);
    },
  );

describeWithEnv("Admin API listing regressions", { db: true }, () => {
  test("keeps only positive day counts in create input", async () => {
    const result = await bodyToCreateInput({
      day_prices: { 0: 700, 1: 500 },
      max_attendees: 10,
      name: "Positive Days Only",
    });

    if (!result.ok) throw new Error(result.error);
    expect(result.value.dayPrices).toEqual({ 1: 500 });
  });

  test("names invalid group IDs in create input", async () => {
    await expect(
      bodyToCreateInput({
        group_ids: ["1"],
        max_attendees: 10,
        name: "Numeric Groups",
      }),
    ).resolves.toEqual({
      error: "group_ids must contain only positive integer ids",
      ok: false,
    });
  });

  test("requires group IDs to be an array", async () => {
    await expect(
      bodyToCreateInput({
        group_ids: "1",
        max_attendees: 10,
        name: "Group Array Required",
      }),
    ).resolves.toEqual({ error: "group_ids must be an array", ok: false });
  });

  test("requires a create name", async () => {
    await expect(
      bodyToCreateInput({ max_attendees: 10, name: " " }),
    ).resolves.toEqual({ error: "name is required", ok: false });
  });

  test("requires at least one attendee on create", async () => {
    await expect(
      bodyToCreateInput({ max_attendees: 0, name: "No Capacity" }),
    ).resolves.toEqual({
      error: "max_attendees is required and must be >= 1",
      ok: false,
    });
  });

  test("defaults max_price to zero", async () => {
    await assertJson(
      apiRequest("/api/admin/listings", {
        body: { max_attendees: 10, name: "Default Maximum Price" },
        method: "POST",
      }),
      201,
      (body) => {
        expect(body.listing.max_price).toBe(0);
        expect(body.listing.slug_index).toBeUndefined();
      },
    );
  });

  test("keeps a submitted maximum price", async () => {
    await assertJson(
      apiRequest("/api/admin/listings", {
        body: {
          max_attendees: 10,
          max_price: 1500,
          name: "Maximum Price",
        },
        method: "POST",
      }),
      201,
      (body) => {
        expect(body.listing.max_price).toBe(1500);
      },
    );
  });

  test("rejects a daily child for a new standard parent", async () => {
    const child = await createTestListing({
      listingType: "daily",
      name: "Daily Child",
    });

    await assertJson(
      apiRequest("/api/admin/listings", {
        body: {
          child_listing_ids: [child.id],
          max_attendees: 10,
          name: "Standard Parent",
        },
        method: "POST",
      }),
      400,
      (body) => {
        expect(body.error).toBe(
          "'Daily Child' is a daily listing, so it can only be a child of another daily listing — a daily add-on takes its date and length from the parent it is booked under, and only a daily listing supplies them.",
        );
      },
    );
  });

  test("rejects a non-array child listing value", async () => {
    const listing = await createTestListing({ name: "Child Array Required" });

    await expectListingApiError(
      `/api/admin/listings/${listing.id}`,
      "PUT",
      { child_listing_ids: "1" },
      "child_listing_ids must be an array of listing ids",
    );
  });

  test("rejects a fractional child listing ID", async () => {
    const listing = await createTestListing({ name: "Whole Child IDs" });

    await expectListingApiError(
      `/api/admin/listings/${listing.id}`,
      "PUT",
      { child_listing_ids: [1.5] },
      "child_listing_ids must contain only positive integer listing ids",
    );
  });

  test("accepts listing ID 1 as a positive integer", async () => {
    const listing = await createTestListing({ name: "Positive Child IDs" });

    await assertJson(
      apiRequest(`/api/admin/listings/${listing.id}`, {
        body: { child_listing_ids: [1] },
        method: "PUT",
      }),
      200,
    );
  });

  test("can join a hidden package while clearing children", async () => {
    const group = await createTestGroup({
      hidePackageListings: true,
      isPackage: true,
      name: "Hidden package",
    });
    const parent = await createTestListing({ name: "Joining package" });
    const child = await createTestListing({ name: "Former child" });
    await postChildren(parent.id, [child.id]);

    await assertJson(
      apiRequest(`/api/admin/listings/${parent.id}`, {
        body: { child_listing_ids: [], group_ids: [group.id] },
        method: "PUT",
      }),
      200,
    );
    expect(await listingGroups.getIds(parent.id)).toEqual([group.id]);
    expect(await listingChildren.getIds(parent.id)).toEqual([]);
  });

  test("deletes a listing through its API route", async () => {
    const listing = await createTestListing({ name: "Delete Through API" });

    await assertJson(
      apiRequest(`/api/admin/listings/${listing.id}`, {
        body: { confirm_identifier: listing.name },
        method: "DELETE",
      }),
      200,
      (body) => {
        expect(body.status).toBe("ok");
      },
    );
  });

  test("rejects deletion that would orphan a child-only add-on", async () => {
    const { thatPage } = await rescuingPageSetup();

    await expectListingApiError(
      `/api/admin/listings/${thatPage.id}`,
      "DELETE",
      { confirm_identifier: thatPage.name },
      t("modifiers.err_child_only_addon", { name: "Child-scoped extra" }),
    );
    expect(await getListingWithCount(thatPage.id)).not.toBeNull();
  });

  test("names the listing confirmation field when deletion is rejected", async () => {
    const listing = await createTestListing({ name: "Protected Listing" });

    await expectListingApiError(
      `/api/admin/listings/${listing.id}`,
      "DELETE",
      { confirm_identifier: "Wrong Name" },
      "Listing name does not match. Please provide the exact listing name in confirm_identifier.",
    );
  });

  test("reports a missing listing from the delete route", async () => {
    await assertJson(
      apiRequest("/api/admin/listings/99999", {
        body: { confirm_identifier: "Missing" },
        method: "DELETE",
      }),
      404,
      (body) => {
        expect(body.error).toBe("Listing not found");
      },
    );
  });

  test("reports when a listing is already deactivated", async () => {
    const listing = await createTestListing({ name: "Already Deactivated" });

    await assertJson(
      apiRequest(`/api/admin/listings/${listing.id}/deactivate`, {
        method: "POST",
      }),
      200,
      (body) => {
        expect(body.listing.active).toBe(false);
      },
    );
    await expectListingApiError(
      `/api/admin/listings/${listing.id}/deactivate`,
      "POST",
      {},
      "Listing is already deactivated",
    );
  });

  test("reports when a listing is already active", async () => {
    const listing = await createTestListing({ name: "Already Active" });

    await expectListingApiError(
      `/api/admin/listings/${listing.id}/reactivate`,
      "POST",
      {},
      "Listing is already active",
    );
  });

  test("refuses group IDs for a listing that assigns a built site", async () => {
    using _env = withEnv({ CAN_BUILD_SITES: "true" });
    const group = await createTestGroup({ name: "API Plan Refusal Group" });
    const plan = await createTestListing({
      assignBuiltSite: true,
      initialSiteMonths: 1,
      name: "API Refused Plan",
    });

    await expectListingApiError(
      `/api/admin/listings/${plan.id}`,
      "PUT",
      { group_ids: [group.id] },
      sitePlanMemberError(plan.name),
    );
    expect(await listingGroups.getIds(plan.id)).toEqual([]);
  });

  test("refuses child listing IDs for a listing that assigns a built site", async () => {
    using _env = withEnv({ CAN_BUILD_SITES: "true" });
    const plan = await createTestListing({
      assignBuiltSite: true,
      initialSiteMonths: 1,
      name: "API Childless Plan",
    });
    const child = await createTestListing({ name: "API Plan Child" });

    await expectListingApiError(
      `/api/admin/listings/${plan.id}`,
      "PUT",
      { child_listing_ids: [child.id] },
      t("listings_table.children_err_parent_site_plan", { name: plan.name }),
    );
    expect(await listingChildren.getIds(plan.id)).toEqual([]);
  });

  test("refuses grouping a built-site plan even when the patch omits its flag", async () => {
    // The API cannot set assign_built_site, so an earlier flag stored true
    // must survive into the merged update input — not read as absent.
    using _env = withEnv({ CAN_BUILD_SITES: "true" });
    const group = await createTestGroup({ name: "API Omitted Flag Group" });
    const plan = await createTestListing({
      assignBuiltSite: true,
      initialSiteMonths: 1,
      name: "API Omitted Flag Plan",
    });

    await expectListingApiError(
      `/api/admin/listings/${plan.id}`,
      "PUT",
      { group_ids: [group.id], max_attendees: 12 },
      sitePlanMemberError(plan.name),
    );
    expect(await listingGroups.getIds(plan.id)).toEqual([]);
  });

  test("accepts clearing the groups of a listing that assigns a built site", async () => {
    using _env = withEnv({ CAN_BUILD_SITES: "true" });
    const group = await createTestGroup({ name: "API Plan Removal Group" });
    const plan = await createTestListing({
      assignBuiltSite: true,
      initialSiteMonths: 1,
      name: "API Removal Plan",
    });
    const { setListingGroups } = await import("#db/groups.ts");
    await setListingGroups(plan.id, [group.id]);

    await assertJson(
      apiRequest(`/api/admin/listings/${plan.id}`, {
        body: { group_ids: [] },
        method: "PUT",
      }),
      200,
    );
    expect(await listingGroups.getIds(plan.id)).toEqual([]);
  });
});
