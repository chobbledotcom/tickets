import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { signCsrfToken } from "#shared/csrf.ts";
import {
  formRequest,
  imageNamesForItem,
  makeImage,
  postImageUpload,
} from "#test-utils/admin-images.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest, withStorageMock } from "#test-utils/mocks.ts";
import { createTestEditorSession } from "#test-utils/session.ts";

describeWithEnv("editor listing images", { db: true, storage: "cdn" }, () => {
  test("opens the Images tab", async () => {
    const { cookie } = await createTestEditorSession();
    const listing = await createTestListing();
    const response = await awaitTestRequest(
      `/admin/listing/${listing.id}/images`,
      { cookie },
    );
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain(`action="/admin/listing/${listing.id}/images"`);
    expect(html).toContain(
      `action="/admin/listing/${listing.id}/images/upload"`,
    );
  });

  test("selects an existing listing image", async () => {
    const { cookie } = await createTestEditorSession();
    const listing = await createTestListing();
    const image = await makeImage("Editor selected image");
    const response = await handleRequest(
      formRequest(
        `/admin/listing/${listing.id}/images`,
        [
          ["csrf_token", await signCsrfToken()],
          ["image_ids", String(image.id)],
        ],
        cookie,
      ),
    );
    expect(response.status).toBe(302);
    expect(await imageNamesForItem("listing", listing.id)).toEqual([
      "Editor selected image",
    ]);
  });

  test("uploads a new listing image", async () => {
    const { cookie } = await createTestEditorSession();
    const listing = await createTestListing();
    await withStorageMock(async () => {
      const response = await postImageUpload(
        `/admin/listing/${listing.id}/images/upload`,
        cookie,
        await signCsrfToken(),
        "Editor uploaded image",
      );
      expect(response.status).toBe(302);
    });
    expect(await imageNamesForItem("listing", listing.id)).toEqual([
      "Editor uploaded image",
    ]);
  });
});
