/** The listing page toggle handlers' repeat refusals: the transaction reads
 *  the stored row and the page answers with the plain-words copy. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getListingWithCount } from "#db/listings/records.ts";
import { t } from "#i18n";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { ownerPagePost } from "./parity/helpers.ts";

describeWithEnv("listing page toggle refusals", { db: true }, () => {
  test("deactivate refuses an already deactivated listing", async () => {
    const listing = await createTestListing({ name: "Already Off" });
    await ownerPagePost(`/admin/listing/${listing.id}/deactivate`, {
      confirm_identifier: "Already Off",
    });
    const repeat = await ownerPagePost(
      `/admin/listing/${listing.id}/deactivate`,
      { confirm_identifier: "Already Off" },
    );
    await expectFlashRedirect(
      `/admin/listing/${listing.id}/deactivate`,
      t("error.listing_already_deactivated"),
      false,
    )(repeat);
    expect((await getListingWithCount(listing.id))?.active).toBe(false);
  });

  test("reactivate refuses an already active listing", async () => {
    const listing = await createTestListing({ name: "Already On" });
    const repeat = await ownerPagePost(
      `/admin/listing/${listing.id}/reactivate`,
      { confirm_identifier: "Already On" },
    );
    await expectFlashRedirect(
      `/admin/listing/${listing.id}/reactivate`,
      t("error.listing_already_active"),
      false,
    )(repeat);
    expect((await getListingWithCount(listing.id))?.active).toBe(true);
  });
});
