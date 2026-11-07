import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { createExternalSourceLink } from "#db/external-sources/queries.ts";
import { externalSourcesTable } from "#db/external-sources/tables.ts";
import { assertAdminHtml, testRequiresAuth } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminGet } from "#test-utils/session.ts";
import { featureSetting, useSetting } from "#test-utils/settings.ts";

const PATH = "/admin/external-sources";

/** One source with one listing link, made the way the API makes it. */
const seedDirectory = async (): Promise<{ listingId: number }> => {
  const source = await externalSourcesTable.insert({
    name: "Village diary",
    urlPattern: "https://diary.example/events/{external_id}",
  });
  const listing = await createTestListing({ name: "Watercolour day" });
  const created = await createExternalSourceLink(source.id, {
    externalId: "EVT-1",
    linkId: listing.id,
    linkType: "listing",
  });
  if (!created.ok) throw new Error(created.error);
  return { listingId: listing.id };
};

describeWithEnv("server (admin external sources)", { db: true }, () => {
  describe("while the feature is on", () => {
    useSetting(featureSetting("externalSources"));

    testRequiresAuth(PATH);

    test("shows every source and the links it holds", async () => {
      const { listingId } = await seedDirectory();

      await assertAdminHtml(
        PATH,
        "<title>External sources</title>",
        "<h2>Village diary</h2>",
        "<code>https://diary.example/events/{external_id}</code>",
        `href="/admin/listing/${listingId}"`,
        "EVT-1",
        "https://diary.example/events/EVT-1",
      );
    });

    test("names a record the other system has not named yet", async () => {
      const source = await externalSourcesTable.insert({
        name: "Imports",
        urlPattern: "https://imports.example/{external_id}",
      });
      const listing = await createTestListing({ name: "Pottery day" });
      await createExternalSourceLink(source.id, {
        externalId: null,
        linkId: listing.id,
        linkType: "listing",
      });

      await assertAdminHtml(PATH, "Imports", "Not named yet");
    });
  });

  describe("while the feature is off", () => {
    useSetting(featureSetting());

    test("answers 404, so no page is served for a hidden feature", async () => {
      expect((await adminGet(PATH)).status).toBe(404);
    });
  });
});
