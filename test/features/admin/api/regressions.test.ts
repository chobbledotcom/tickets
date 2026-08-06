import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { bodyToCreateInput } from "#routes/admin/api.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import { rescuingPageSetup } from "#test/test-utils/listing-parents/helpers.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
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
});
