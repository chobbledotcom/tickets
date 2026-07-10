import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { getListingWithCount, listingsTable } from "#shared/db/listings.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  installUrlHandler,
  mockFormRequest,
  withExpectedError,
  withFetchMock,
  withStorageMock,
} from "#test-utils/mocks.ts";
import {
  setupListingAndLogin,
  testCookie,
  testCsrfToken,
} from "#test-utils/session.ts";

/** Submit a POST to /admin/listing/:id/attachment/delete */
const submitAttachmentDelete = (
  listingId: number,
  cookie: string,
  csrfToken: string,
): Promise<Response> =>
  handleRequest(
    mockFormRequest(
      `/admin/listing/${listingId}/attachment/delete`,
      { csrf_token: csrfToken },
      cookie,
    ),
  );

describeWithEnv(
  "server images > attachment delete",
  {
    db: true,
    env: {
      STORAGE_ZONE_KEY: "testkey",
      STORAGE_ZONE_NAME: "testzone",
    },
  },
  () => {
    describe("POST /admin/listing/:id/attachment/delete", () => {
      test("removes attachment from listing and storage", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();
        await listingsTable.update(listing.id, {
          attachmentName: "file.pdf",
          attachmentUrl: "to-delete.pdf",
        });

        await withStorageMock(async () => {
          const response = await submitAttachmentDelete(
            listing.id,
            cookie,
            csrfToken,
          );
          await expectFlashRedirect(
            `/admin/listing/${listing.id}`,
            "Attachment removed",
          )(response);

          const updated = await getListingWithCount(listing.id);
          expect(updated?.attachment_url).toBe("");
          expect(updated?.attachment_name).toBe("");
        });
      });

      test("redirects when listing has no attachment", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();

        const response = await submitAttachmentDelete(
          listing.id,
          cookie,
          csrfToken,
        );
        await expectFlashRedirect(
          `/admin/listing/${listing.id}`,
          "Attachment removed",
        )(response);
      });

      test("keeps attachment linked when storage deletion fails", async () => {
        const { listing, cookie, csrfToken } = await setupListingAndLogin();
        await listingsTable.update(listing.id, {
          attachmentName: "guide.pdf",
          attachmentUrl: "delete-fails.pdf",
        });

        await withExpectedError(async () => {
          await withFetchMock(async (originalFetch) => {
            installUrlHandler(originalFetch, (url) =>
              url.includes("delete-fails.pdf")
                ? Promise.reject(new Error("CDN delete failed"))
                : null,
            );
            const response = await submitAttachmentDelete(
              listing.id,
              cookie,
              csrfToken,
            );
            await expectFlashRedirect(
              `/admin/listing/${listing.id}`,
              "Attachment removal failed",
              false,
            )(response);
          });
        });

        const updated = await getListingWithCount(listing.id);
        expect(updated?.attachment_url).toBe("delete-fails.pdf");
        expect(updated?.attachment_name).toBe("guide.pdf");
      });

      test("returns 404 for non-existent listing", async () => {
        const cookie = await testCookie();
        const csrfToken = await testCsrfToken();

        const response = await submitAttachmentDelete(9999, cookie, csrfToken);
        expect(response.status).toBe(404);
      });
    });
  },
);
