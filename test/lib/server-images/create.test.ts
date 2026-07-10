import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { getAllListings } from "#shared/db/listings.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { PDF_BYTES } from "#test-utils/factories.ts";
import { mockMultipartRequest, withStorageMock } from "#test-utils/mocks.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";
import { makeTestPng } from "#test-utils/test-image.ts";

/** Shared form fields for creating a new listing via POST /admin/listing */
const newListingFormFields = (
  csrfToken: string,
  name: string,
): Record<string, string> => ({
  bookable_days: "Monday,Tuesday,Wednesday,Thursday,Friday",
  closes_at_date: "",
  closes_at_time: "",
  csrf_token: csrfToken,
  date_date: "",
  date_time: "",
  description: "",
  fields: "email",
  listing_type: "standard",
  location: "",
  max_attendees: "50",
  max_quantity: "1",
  maximum_days_after: "",
  minimum_days_before: "",
  name,
  thank_you_url: "",
  unit_price: "",
  webhook_url: "",
});

/** Submit a create-listing form with a file attached under the given field,
 * then look up the created listing by name. Collapses the shared
 * "submit → 302 → find the new listing" scaffold every create-form test
 * here spells out. */
const createListingWithFile = async (
  cookie: string,
  csrfToken: string,
  listingName: string,
  fieldName: "image" | "attachment",
  file: { name: string; data: Uint8Array; contentType: string },
): Promise<{ created: ListingWithCount | undefined; response: Response }> => {
  const response = await handleRequest(
    mockMultipartRequest(
      "/admin/listing",
      newListingFormFields(csrfToken, listingName),
      cookie,
      { fieldName, ...file },
    ),
  );
  expect(response.status).toBe(302);
  const listings = await getAllListings();
  const created = listings.find((e) => e.name === listingName);
  return { created, response };
};

describeWithEnv(
  "server images > create",
  {
    db: true,
    env: {
      STORAGE_ZONE_KEY: "testkey",
      STORAGE_ZONE_NAME: "testzone",
    },
  },
  () => {
    describe("POST /admin/listing (stray image upload field)", () => {
      test("ignores image when creating a new listing", async () => {
        const cookie = await testCookie();
        const csrfToken = await testCsrfToken();

        await withStorageMock(async () => {
          const { created } = await createListingWithFile(
            cookie,
            csrfToken,
            "Image Test Listing",
            "image",
            {
              contentType: "image/png",
              data: await makeTestPng(80, 60),
              name: "photo.png",
            },
          );
          expect(created).not.toBeUndefined();
          expect(created?.image_url).toBe("");
          expect(created?.image_thumb_url).toBe("");
        });
      });

      test("does not validate ignored image field when creating listing", async () => {
        const cookie = await testCookie();
        const csrfToken = await testCsrfToken();

        await withStorageMock(async () => {
          const { created } = await createListingWithFile(
            cookie,
            csrfToken,
            "Bad Image Listing",
            "image",
            {
              contentType: "application/pdf",
              data: PDF_BYTES,
              name: "test.pdf",
            },
          );
          expect(created).not.toBeUndefined();
          expect(created?.image_url).toBe("");
        });
      });
    });

    describe("POST /admin/listing (attachment upload via create form)", () => {
      test("uploads attachment when creating a new listing", async () => {
        const cookie = await testCookie();
        const csrfToken = await testCsrfToken();

        await withStorageMock(async () => {
          const { created, response } = await createListingWithFile(
            cookie,
            csrfToken,
            "Attachment Listing",
            "attachment",
            {
              contentType: "application/pdf",
              data: PDF_BYTES,
              name: "info.pdf",
            },
          );
          await expectFlashRedirect("/admin", "Listing created")(response);
          expect(created?.attachment_url).toMatch(/info\.pdf$/);
          expect(created?.attachment_name).toBe("info.pdf");
        });
      });
    });
  },
);
