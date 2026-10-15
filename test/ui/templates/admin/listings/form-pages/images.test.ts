import { assert } from "@std/assert";
import { describe, it as test } from "@std/testing/bdd";
import { runWithStorageConfig } from "#shared/storage.ts";
import {
  adminDuplicateListingPage,
  adminListingNewPage,
} from "#templates/admin/listings/form-pages.tsx";
import {
  detailHtml,
  editPanelHtml,
  registerListingTemplateHooks,
  withBuilder,
  withoutBuilder,
} from "#test/ui/templates/admin/listings/helpers.ts";
import { OWNER_SESSION } from "#test-utils/admin-page-test.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { testListingWithCount } from "#test-utils/factories.ts";
import { TEST_STORAGE_ZONE } from "#test-utils/internal.ts";
import { withStorageDisabled } from "#test-utils/mocks.ts";
import { says } from "#test-utils/says.ts";

/** A listing carrying the renewal-tier builder fields, shared by the
 *  months_per_unit / initial_site_months visibility tests. */
const builderListing = () =>
  testListingWithCount({ initial_site_months: 6, months_per_unit: 3 });

/** Neither the duplicate form nor the new-listing form ever renders an image
 *  control — the shared assertion for the two storage-ownership tests. */
const expectNoImageInDuplicateAndNew = (
  listing: Parameters<typeof adminDuplicateListingPage>[0],
): void => {
  assert(
    !adminDuplicateListingPage(listing, [], OWNER_SESSION).includes(
      'name="image"',
    ),
  );
  assert(!adminListingNewPage([], OWNER_SESSION).includes('name="image"'));
};

describeWithEnv(
  "listing images",
  { env: { STORAGE_ZONE_KEY: "testkey", STORAGE_ZONE_NAME: "testzone" } },
  () => {
    registerListingTemplateHooks();

    describe("adminListingPage image section", () => {
      test("does not show image upload on detail page", () => {
        const html = detailHtml(testListingWithCount({ image_url: "" }));
        assert(!html.includes('type="file"'));
        assert(!html.includes('name="image"'));
      });
    });

    describe("listing form image ownership", () => {
      test("does not show image controls on the edit form", () => {
        runWithStorageConfig(TEST_STORAGE_ZONE, () => {
          const html = editPanelHtml(
            testListingWithCount({ image_url: "current.jpg" }),
          );
          assert(!html.includes('name="image"'));
          assert(!html.includes("Remove Image"));
          assert(!html.includes("/image/delete"));
          assert(!html.includes("listing-image-full"));
        });
      });

      test("does not show image controls on duplicate or create forms", () => {
        runWithStorageConfig(TEST_STORAGE_ZONE, () => {
          expectNoImageInDuplicateAndNew(
            testListingWithCount({ image_url: "current.jpg" }),
          );
        });
      });

      test("keeps image controls absent when storage is disabled", () => {
        withStorageDisabled(() => {
          const listing = testListingWithCount({ image_url: "current.jpg" });
          assert(!editPanelHtml(listing).includes('name="image"'));
          expectNoImageInDuplicateAndNew(listing);
        });
      });
    });

    describe("assign_built_site field", () => {
      test("shows assign built site field when CAN_BUILD_SITES is true", () => {
        withBuilder(() => {
          const html = adminListingNewPage([], OWNER_SESSION);
          says(html, "assign_built_site");
          says(html, "Assign a site on booking");
        });
      });

      test("hides assign built site field when CAN_BUILD_SITES is not set", () => {
        withoutBuilder(() => {
          const html = adminListingNewPage([], OWNER_SESSION);
          assert(!html.includes("assign_built_site"));
        });
      });

      test("shows on edit page when CAN_BUILD_SITES is true", () => {
        withBuilder(() => {
          const html = editPanelHtml(
            testListingWithCount({ assign_built_site: true }),
          );
          says(html, "assign_built_site");
          says(html, "checked");
        });
      });

      test("shows on duplicate page when CAN_BUILD_SITES is true", () => {
        withBuilder(() => {
          const listing = testListingWithCount({ assign_built_site: true });
          const html = adminDuplicateListingPage(listing, [], OWNER_SESSION);
          says(html, "assign_built_site");
        });
      });
    });

    describe("months_per_unit and initial_site_months fields", () => {
      test("shows months_per_unit and initial_site_months when CAN_BUILD_SITES is true", () => {
        withBuilder(() => {
          const html = adminListingNewPage([], OWNER_SESSION);
          says(html, "months_per_unit");
          says(html, "Months per unit");
          says(html, "initial_site_months");
          says(html, "Initial site months");
        });
      });

      test("hides months_per_unit and initial_site_months when CAN_BUILD_SITES is not set", () => {
        withoutBuilder(() => {
          const html = adminListingNewPage([], OWNER_SESSION);
          assert(!html.includes("months_per_unit"));
          assert(!html.includes("Months per unit"));
          assert(!html.includes("initial_site_months"));
          assert(!html.includes("Initial site months"));
        });
      });

      test("shows on edit page when CAN_BUILD_SITES is true", () => {
        withBuilder(() => {
          const html = editPanelHtml(builderListing());
          says(html, "months_per_unit");
          says(html, "initial_site_months");
        });
      });

      test("hides on edit page when CAN_BUILD_SITES is not set", () => {
        withoutBuilder(() => {
          const html = editPanelHtml(builderListing());
          assert(!html.includes("months_per_unit"));
          assert(!html.includes("initial_site_months"));
        });
      });

      test("shows on duplicate page when CAN_BUILD_SITES is true", () => {
        withBuilder(() => {
          const html = adminDuplicateListingPage(
            builderListing(),
            [],
            OWNER_SESSION,
          );
          says(html, "months_per_unit");
          says(html, "initial_site_months");
        });
      });

      test("hides on duplicate page when CAN_BUILD_SITES is not set", () => {
        withoutBuilder(() => {
          const html = adminDuplicateListingPage(
            builderListing(),
            [],
            OWNER_SESSION,
          );
          assert(!html.includes("months_per_unit"));
          assert(!html.includes("initial_site_months"));
        });
      });
    });
  },
);
