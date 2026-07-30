import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getSelectedAttributesForListings } from "#shared/db/attributes.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import { expectFlashRedirect, expectStatus } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttributeWithOptions } from "#test-utils/db-helpers/attributes.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminFormPost } from "#test-utils/session.ts";
import { enableFeature } from "#test-utils/settings.ts";

describeWithEnv("server (listing attributes tab save)", { db: true }, () => {
  describe("POST /admin/listing/:id/attributes", () => {
    test("saving a listing's options stores them, logs them, and says so", async () => {
      const attribute = await createTestAttributeWithOptions("Difficulty", [
        "Easy",
        "Hard",
      ]);
      await enableFeature("attributes");
      const listing = await createTestListing({ name: "Climbing" });
      const easy = attribute.options[0]!;

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/attributes`,
        { option_ids: String(easy.id) },
      );

      await expectFlashRedirect(
        `/admin/listing/${listing.id}/attributes`,
        "Attributes updated",
        true,
      )(response);
      const selected = await getSelectedAttributesForListings([listing.id]);
      expect(
        selected.get(listing.id)![0]!.options.map((option) => option.text),
      ).toEqual(["Easy"]);
      expect(await activityMessages()).toContain(
        "Attributes updated for 'Climbing' (1 option)",
      );
    });

    test("the save is refused while the attributes feature is off", async () => {
      const listing = await createTestListing({ name: "No feature" });

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/attributes`,
        {},
      );

      expectStatus(404)(response);
    });
  });
});
