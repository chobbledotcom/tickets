import { assert, assertStringIncludes } from "@std/assert";
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
import { expectExcludesAll } from "#test-utils/assertions/absent.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { testListingWithCount } from "#test-utils/factories.ts";
import { TEST_STORAGE_ZONE } from "#test-utils/internal.ts";
import { withStorageDisabled } from "#test-utils/mocks.ts";

/** A listing carrying the renewal-tier builder fields, shared by the
 *  months_per_unit / initial_site_months visibility tests. */
const builderListing = () =>
  testListingWithCount({ initialSiteMonths: 6, monthsPerUnit: 3 });

/** Neither the duplicate form nor the new-listing form ever renders an image
 *  control — the shared assertion for the two storage-ownership tests. */
const expectNoImageInDuplicateAndNew = (
  listing: Parameters<typeof adminDuplicateListingPage>[0],
): void => {
  for (const html of [
    adminDuplicateListingPage(listing, [], OWNER_SESSION),
    adminListingNewPage([], OWNER_SESSION),
  ]) {
    expectExcludesAll(html, ['name="imageIds"']);
  }
};

describeWithEnv(
  "listing images",
  { env: { STORAGE_ZONE_KEY: "testkey", STORAGE_ZONE_NAME: "testzone" } },
  () => {
    registerListingTemplateHooks();

    describe("adminListingPage image section", () => {
      test("does not show image upload on detail page", () => {
        const html = detailHtml(testListingWithCount({ imageUrl: "" }));
        expectExcludesAll(html, ['type="file"', 'name="image"']);
      });
    });

    describe("listing form image ownership", () => {
      test("does not show image controls on the edit form", () => {
        runWithStorageConfig(TEST_STORAGE_ZONE, () => {
          const html = editPanelHtml(
            testListingWithCount({ imageUrl: "current.jpg" }),
          );
          expectExcludesAll(html, [
            'name="image"',
            "Remove Image",
            "/image/delete",
            "listing-image-full",
          ]);
        });
      });

      test("does not show image controls on duplicate or create forms", () => {
        runWithStorageConfig(TEST_STORAGE_ZONE, () => {
          expectNoImageInDuplicateAndNew(
            testListingWithCount({ imageUrl: "current.jpg" }),
          );
        });
      });

      test("keeps image controls absent when storage is disabled", () => {
        withStorageDisabled(() => {
          const listing = testListingWithCount({ imageUrl: "current.jpg" });
          assert(!editPanelHtml(listing).includes('name="image"'));
          expectNoImageInDuplicateAndNew(listing);
        });
      });
    });

    describe("assign_built_site field", () => {
      test("shows assign built site field when CAN_BUILD_SITES is true", () => {
        withBuilder(() => {
          const html = adminListingNewPage([], OWNER_SESSION);
          expectIncludesAll(html, [
            'name="assignBuiltSite"',
            "Assign a site on booking",
          ]);
        });
      });

      test("hides assign built site field when CAN_BUILD_SITES is not set", () => {
        withoutBuilder(() => {
          const html = adminListingNewPage([], OWNER_SESSION);
          assert(!html.includes('name="assignBuiltSite"'));
        });
      });

      test("shows on edit page when CAN_BUILD_SITES is true", () => {
        withBuilder(() => {
          const html = editPanelHtml(
            testListingWithCount({ assignBuiltSite: true }),
          );
          expectIncludesAll(html, ['name="assignBuiltSite"', "checked"]);
        });
      });

      test("shows on duplicate page when CAN_BUILD_SITES is true", () => {
        withBuilder(() => {
          const listing = testListingWithCount({ assignBuiltSite: true });
          const html = adminDuplicateListingPage(listing, [], OWNER_SESSION);
          assertStringIncludes(html, 'name="assignBuiltSite"');
        });
      });
    });

    describe("months_per_unit and initial_site_months fields", () => {
      test("shows months_per_unit and initial_site_months when CAN_BUILD_SITES is true", () => {
        withBuilder(() => {
          const html = adminListingNewPage([], OWNER_SESSION);
          expectIncludesAll(html, [
            'name="monthsPerUnit"',
            "Months per unit",
            'name="initialSiteMonths"',
            "Initial site months",
          ]);
        });
      });

      test("hides months_per_unit and initial_site_months when CAN_BUILD_SITES is not set", () => {
        withoutBuilder(() => {
          const html = adminListingNewPage([], OWNER_SESSION);
          expectExcludesAll(html, [
            'name="monthsPerUnit"',
            "Months per unit",
            'name="initialSiteMonths"',
            "Initial site months",
          ]);
        });
      });

      test("shows on edit page when CAN_BUILD_SITES is true", () => {
        withBuilder(() => {
          const html = editPanelHtml(builderListing());
          expectIncludesAll(html, [
            'name="monthsPerUnit"',
            'name="initialSiteMonths"',
          ]);
        });
      });

      test("hides on edit page when CAN_BUILD_SITES is not set", () => {
        withoutBuilder(() => {
          const html = editPanelHtml(builderListing());
          expectExcludesAll(html, [
            'name="monthsPerUnit"',
            'name="initialSiteMonths"',
          ]);
        });
      });

      test("shows on duplicate page when CAN_BUILD_SITES is true", () => {
        withBuilder(() => {
          const html = adminDuplicateListingPage(
            builderListing(),
            [],
            OWNER_SESSION,
          );
          expectIncludesAll(html, [
            'name="monthsPerUnit"',
            'name="initialSiteMonths"',
          ]);
        });
      });

      test("hides on duplicate page when CAN_BUILD_SITES is not set", () => {
        withoutBuilder(() => {
          const html = adminDuplicateListingPage(
            builderListing(),
            [],
            OWNER_SESSION,
          );
          expectExcludesAll(html, [
            'name="monthsPerUnit"',
            'name="initialSiteMonths"',
          ]);
        });
      });
    });
  },
);
