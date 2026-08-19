/**
 * A listing's uploaded file: the redirect a save makes after handling it, and
 * what removing one does. Storage is not configured here, so these cover the
 * paths that do not need a storage zone.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { processUploadsAndRedirect } from "#routes/admin/listings-uploads.ts";
import { listingsTable } from "#shared/db/listings/records.ts";
import { expectRedirectWithFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminFormPost } from "#test-utils/session.ts";

describe("the redirect after a save that handled uploads", () => {
  test("says plainly that the save worked when nothing else happened", async () => {
    const response = await processUploadsAndRedirect(
      new FormData(),
      1,
      "/admin/listing/1",
      "Listing updated",
    );

    expectRedirectWithFlash("/admin/listing/1", "Listing updated")(response);
  });

  test("carries a caveat rather than an unqualified success", async () => {
    // A partial outcome must never read as a plain success, so the caveat
    // rides along with the message, and the flash stops being a success.
    const response = await processUploadsAndRedirect(
      new FormData(),
      1,
      "/admin/listing/1",
      "Listing duplicated",
      undefined,
      "its required child was left off",
    );

    expectRedirectWithFlash(
      "/admin/listing/1",
      "Listing duplicated but: its required child was left off",
      false,
    )(response);
  });
});

describeWithEnv("removing a listing's attachment", { db: true }, () => {
  test("keeps the stored URL when the file could not be deleted", async () => {
    // No storage zone is configured here, so the delete fails. Clearing the
    // record anyway would lose the only pointer to a file still sitting in
    // storage, so the record keeps it and the operator is told.
    const listing = await createTestListing({ name: "Has A Leaflet" });
    await listingsTable.update(listing.id, {
      attachmentName: "leaflet.pdf",
      attachmentUrl: "https://example.test/leaflet.pdf",
    });

    const { response } = await adminFormPost(
      `/admin/listing/${listing.id}/attachment/delete`,
      {},
    );

    expectRedirectWithFlash(
      `/admin/listing/${listing.id}`,
      "Attachment removal failed",
      false,
    )(response);
    const after = await listingsTable.read.pick(["attachment_url"]).one({
      id: listing.id,
    });
    expect(after!.attachment_url).toBe("https://example.test/leaflet.pdf");
  });

  test("reports success when there was nothing to remove", async () => {
    const listing = await createTestListing({ name: "No Leaflet" });

    const { response } = await adminFormPost(
      `/admin/listing/${listing.id}/attachment/delete`,
      {},
    );

    expectRedirectWithFlash(
      `/admin/listing/${listing.id}`,
      "Attachment removed",
    )(response);
  });

  test("answers 404 for a listing that is not there", async () => {
    const { response } = await adminFormPost(
      "/admin/listing/99999/attachment/delete",
      {},
    );

    expect(response.status).toBe(404);
  });
});
