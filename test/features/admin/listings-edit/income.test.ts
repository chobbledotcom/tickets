/**
 * Correcting a listing's projected income by hand.
 *
 * The owner types the figure the listing should show, and the difference from
 * what it currently projects is posted as a write-off. The route is owner-only
 * and reads the figure from the `income` field.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getListingWithCount } from "#db/listings/records.ts";
import { t } from "#i18n";
import { expectRedirect, parseFlashCookie } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminFormPost } from "#test-utils/session.ts";

const incomeOf = async (id: number): Promise<number> =>
  (await getListingWithCount(id))!.income;

describeWithEnv("correcting a listing's income", { db: true }, () => {
  test("moves the projection to the figure the owner typed", async () => {
    const listing = await createTestListing({ name: "Wrong Income" });
    expect(await incomeOf(listing.id)).toBe(0);

    const { response } = await adminFormPost(
      `/admin/listing/${listing.id}/income`,
      { income: "25.00" },
    );

    expectRedirect(response);
    expect(parseFlashCookie(response).success).toBe(
      t("listings_table.adjust_income_success"),
    );
    expect(await incomeOf(listing.id)).toBe(2500);
  });

  test("posting the same figure again changes nothing", async () => {
    const listing = await createTestListing({ name: "Twice" });
    await adminFormPost(`/admin/listing/${listing.id}/income`, {
      income: "40.00",
    });

    await adminFormPost(`/admin/listing/${listing.id}/income`, {
      income: "40.00",
    });

    expect(await incomeOf(listing.id)).toBe(4000);
  });

  test("refuses a figure that is not an amount", async () => {
    const listing = await createTestListing({ name: "Not A Number" });

    const { response } = await adminFormPost(
      `/admin/listing/${listing.id}/income`,
      { income: "quite a lot" },
    );

    expect(parseFlashCookie(response).error).toBe("Enter a valid amount");
    expect(await incomeOf(listing.id)).toBe(0);
  });

  test("answers 404 for a listing that is not there", async () => {
    const { response } = await adminFormPost("/admin/listing/99999/income", {
      income: "10.00",
    });

    expect(response.status).toBe(404);
  });
});
