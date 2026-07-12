import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import {
  getListingWithCount,
  listingsTable,
} from "#shared/db/listings/records.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  cdnOkResponse,
  installUrlHandler,
  mockFormRequest,
  withFetchMock,
  withStorageMock,
} from "#test-utils/mocks.ts";
import { setupListingAndLogin } from "#test-utils/session.ts";
import { linkStoredImage } from "./helpers.ts";

/** Submit a POST to /admin/listing/:id/delete with confirmation */
const submitListingDelete = (
  listingId: number,
  listingName: string,
  cookie: string,
  csrfToken: string,
): Promise<Response> =>
  handleRequest(
    mockFormRequest(
      `/admin/listing/${listingId}/delete`,
      { confirm_identifier: listingName, csrf_token: csrfToken },
      cookie,
    ),
  );

describeWithEnv(
  "server images > deletion",
  {
    db: true,
    env: {
      STORAGE_ZONE_KEY: "testkey",
      STORAGE_ZONE_NAME: "testzone",
    },
  },
  () => {
    describe("listing deletion cleans up storage files", () => {
      /** Delete the listing and return the storage-delete fetch calls made
       *  during the request. Collapses the shared `withStorageMock` +
       *  `submitListingDelete` + `expect(302)` + `fetchCalls.find` scaffold
       *  every test in this block spells out. */
      const deleteListingAndCaptureCalls = async (
        listing: { id: number; name: string },
        cookie: string,
        csrfToken: string,
      ): Promise<string[]> => {
        const calls: string[] = [];
        await withStorageMock(async (fetchCalls) => {
          const response = await submitListingDelete(
            listing.id,
            listing.name,
            cookie,
            csrfToken,
          );
          expect(response.status).toBe(302);
          calls.push(...fetchCalls);
        });
        return calls;
      };

      test("keeps linked reusable image files when listing is deleted", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();
        await linkStoredImage(listing.id, "listing-image.jpg");

        const fetchCalls = await deleteListingAndCaptureCalls(
          listing,
          cookie,
          csrfToken,
        );
        expect(
          fetchCalls.find((url) => url.includes("listing-image.jpg")),
        ).toBeUndefined();

        const deleted = await getListingWithCount(listing.id);
        expect(deleted).toBeNull();
      });

      test("deletes attachment from storage when listing is deleted", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();
        await listingsTable.update(listing.id, {
          attachmentName: "doc.pdf",
          attachmentUrl: "listing-attachment.pdf",
        });

        const fetchCalls = await deleteListingAndCaptureCalls(
          listing,
          cookie,
          csrfToken,
        );
        expect(
          fetchCalls.find((url) => url.includes("listing-attachment.pdf")),
        ).not.toBeUndefined();
      });

      test("deletes attachment but keeps image when listing is deleted", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();
        await linkStoredImage(listing.id, "both-image.jpg");
        await listingsTable.update(listing.id, {
          attachmentName: "both.pdf",
          attachmentUrl: "both-attachment.pdf",
        });

        const fetchCalls = await deleteListingAndCaptureCalls(
          listing,
          cookie,
          csrfToken,
        );
        expect(
          fetchCalls.find((url) => url.includes("both-image.jpg")),
        ).toBeUndefined();
        expect(
          fetchCalls.find((url) => url.includes("both-attachment.pdf")),
        ).not.toBeUndefined();
      });

      test("succeeds when linked image storage deletion would fail during listing deletion", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();
        await linkStoredImage(listing.id, "failing-image.jpg");

        await withFetchMock(async (originalFetch) => {
          installUrlHandler(originalFetch, (url) => {
            if (url.includes("failing-image.jpg")) {
              return Promise.reject(new Error("CDN delete failed"));
            }
            if (url.includes("storage.bunnycdn.com")) {
              return Promise.resolve(cdnOkResponse());
            }
            return null;
          });

          const response = await submitListingDelete(
            listing.id,
            listing.name,
            cookie,
            csrfToken,
          );
          expect(response.status).toBe(302);

          const deleted = await getListingWithCount(listing.id);
          expect(deleted).toBeNull();
        });
      });

      test("skips storage cleanup when listing has no image or attachment", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();

        await withStorageMock(async (fetchCalls) => {
          const response = await submitListingDelete(
            listing.id,
            listing.name,
            cookie,
            csrfToken,
          );
          expect(response.status).toBe(302);

          const storageCalls = fetchCalls.filter((url) =>
            url.includes("storage.bunnycdn.com"),
          );
          expect(storageCalls).toHaveLength(0);
        });
      });
    });
  },
);
