import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { toMajorUnits } from "#shared/currency.ts";
import {
  getListingWithCount,
  listingsTable,
} from "#shared/db/listings/records.ts";
import { runWithStorageConfig } from "#shared/storage.ts";
import { expectImageErrorRedirect } from "#test/integration/server/images/helpers.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { PDF_BYTES } from "#test-utils/factories.ts";
import type { TestFormValues } from "#test-utils/form-values.ts";
import { TEST_STORAGE_ZONE } from "#test-utils/internal.ts";
import {
  installUrlHandler,
  mockMultipartRequest,
  withFetchMock,
  withStorageDisabled,
  withStorageMock,
} from "#test-utils/mocks.ts";
import { setupListingAndLogin } from "#test-utils/session.ts";

/** Build form data for listing edit with all required fields */
const editFormData = async (
  listingId: number,
  csrfToken: string,
): Promise<TestFormValues> => {
  const listing = await getListingWithCount(listingId);
  if (!listing) throw new Error(`Listing not found: ${listingId}`);
  return {
    bookable_days: listing.bookable_days,
    closes_at_date: "",
    closes_at_time: "",
    csrf_token: csrfToken,
    date_date: "",
    date_time: "",
    description: listing.description,
    fields: (listing.fields || "email").split(","),
    listing_type: listing.listing_type,
    location: listing.location,
    max_attendees: String(listing.max_attendees),
    max_price: toMajorUnits(listing.max_price),
    max_quantity: String(listing.max_quantity),
    maximum_days_after: String(listing.maximum_days_after),
    minimum_days_before: String(listing.minimum_days_before),
    name: listing.name,
    slug: listing.slug,
    thank_you_url: listing.thank_you_url ?? "",
    unit_price: listing.unit_price > 0 ? toMajorUnits(listing.unit_price) : "",
    webhook_url: listing.webhook_url ?? "",
  };
};

const submitEditFile =
  (fieldName: string) =>
  async (
    listingId: number,
    cookie: string,
    csrfToken: string,
    file: { name: string; data: Uint8Array; contentType: string },
  ): Promise<Response> => {
    const fields = await editFormData(listingId, csrfToken);
    return handleRequest(
      mockMultipartRequest(`/admin/listing/${listingId}/edit`, fields, cookie, {
        fieldName,
        ...file,
      }),
    );
  };

/** Submit an edit form with an attachment file */
const submitEditAttachment = submitEditFile("attachment");

const submitEditGuidePdf = (
  listingId: number,
  cookie: string,
  csrfToken: string,
): Promise<Response> =>
  submitEditAttachment(listingId, cookie, csrfToken, {
    contentType: "application/pdf",
    data: PDF_BYTES,
    name: "guide.pdf",
  });

describeWithEnv(
  "server images > attachment edit",
  {
    db: true,
    env: {
      STORAGE_ZONE_KEY: "testkey",
      STORAGE_ZONE_NAME: "testzone",
    },
  },
  () => {
    describe("POST /admin/listing/:id/edit (attachment upload via edit form)", () => {
      test("logs diagnostic when attachment field is not a File", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();

        await withStorageMock(async () => {
          const fields = await editFormData(listing.id, csrfToken);
          // Add attachment as a text field instead of a file
          fields.attachment = "not-a-file";
          const response = await handleRequest(
            mockMultipartRequest(
              `/admin/listing/${listing.id}/edit`,
              fields,
              cookie,
            ),
          );
          await expectFlashRedirect(
            `/admin/listing/${listing.id}`,
            "Listing updated",
          )(response);

          const updated = await getListingWithCount(listing.id);
          expect(updated?.attachment_url).toBe("");
        });
      });

      describeWithEnv(
        "when storage is not configured",
        { env: { STORAGE_ZONE_KEY: undefined, STORAGE_ZONE_NAME: undefined } },
        () => {
          test("ignores attachment", async () => {
            await withStorageDisabled(async () => {
              const { listing, cookie, csrfToken } =
                await setupListingAndLogin();

              const response = await submitEditGuidePdf(
                listing.id,
                cookie,
                csrfToken,
              );
              expect(response.status).toBe(302);
              const updated = await getListingWithCount(listing.id);
              expect(updated?.attachment_url).toBe("");
            });
          });
        },
      );

      test("uploads attachment and updates listing", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();

        await withStorageMock(async () => {
          const response = await submitEditGuidePdf(
            listing.id,
            cookie,
            csrfToken,
          );
          await expectFlashRedirect(
            `/admin/listing/${listing.id}`,
            "Listing updated",
          )(response);

          const updated = await getListingWithCount(listing.id);
          expect(updated?.attachment_url).toMatch(/guide\.pdf$/);
          expect(updated?.attachment_name).toBe("guide.pdf");
        });
      });

      test("rejects oversized attachment", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();

        const oversized = new Uint8Array(25 * 1024 * 1024 + 1);
        await withStorageMock(async () => {
          const response = await submitEditAttachment(
            listing.id,
            cookie,
            csrfToken,
            {
              contentType: "application/zip",
              data: oversized,
              name: "huge.zip",
            },
          );
          expectImageErrorRedirect(response, "25MB");
          const updated = await getListingWithCount(listing.id);
          expect(updated?.attachment_url).toBe("");
        });
      });

      test("deletes old attachment when uploading new one", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();
        await listingsTable.update(listing.id, {
          attachmentName: "old.pdf",
          attachmentUrl: "old-file.pdf",
        });

        await withStorageMock(async (fetchCalls) => {
          const response = await submitEditAttachment(
            listing.id,
            cookie,
            csrfToken,
            {
              contentType: "application/pdf",
              data: PDF_BYTES,
              name: "new.pdf",
            },
          );
          expect(response.status).toBe(302);

          const deleteCall = fetchCalls.find((url) =>
            url.includes("old-file.pdf"),
          );
          expect(deleteCall).not.toBeUndefined();
        });
      });

      test("reports error when attachment upload fails", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();

        await runWithStorageConfig(TEST_STORAGE_ZONE, () =>
          withFetchMock(async (originalFetch) => {
            installUrlHandler(originalFetch, () =>
              Promise.reject(new Error("CDN unreachable")),
            );

            const response = await submitEditGuidePdf(
              listing.id,
              cookie,
              csrfToken,
            );
            expectImageErrorRedirect(response, "upload failed");
          }),
        );
      });
    });
  },
);
