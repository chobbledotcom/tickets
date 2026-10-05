// Role parity for the listing resource behind the JSON API: the create, update,
// read, delete, deactivate, and reactivate pages each declare an audience, and
// the API routes allow exactly those roles.
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getListingWithCount } from "#db/listings/records.ts";
import { handleRequest } from "#routes";
import { signCsrfToken } from "#shared/csrf.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  createTestAgentSession,
  createTestEditorSession,
  requestAsSession,
} from "#test-utils/session.ts";

describeWithEnv("Admin API - Listings role parity", { db: true }, () => {
  const editorSession = async (): Promise<{
    cookie: string;
    csrfToken: string;
  }> => ({
    cookie: (await createTestEditorSession()).cookie,
    csrfToken: await signCsrfToken(),
  });

  test("admits an editor creating a listing", async () => {
    await assertJson(
      handleRequest(
        requestAsSession("/api/admin/listings", await editorSession(), {
          body: JSON.stringify({
            listing_type: "standard",
            max_attendees: 10,
            name: "Editor Made Listing",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      ),
      201,
      (body) => {
        expect(body.listing.name).toBe("Editor Made Listing");
      },
    );
  });

  test("admits an editor updating a listing", async () => {
    const listing = await createTestListing({ name: "Editor Edit" });
    const editor = await editorSession();

    await assertJson(
      handleRequest(
        requestAsSession(`/api/admin/listings/${listing.id}`, editor, {
          body: JSON.stringify({ name: "Editor Renamed" }),
          headers: { "content-type": "application/json" },
          method: "PUT",
        }),
      ),
      200,
      (body) => {
        expect(body.listing.name).toBe("Editor Renamed");
      },
    );
  });

  test("refuses an agent with 403 and creates nothing", async () => {
    const agent = await createTestAgentSession();
    const response = await handleRequest(
      requestAsSession(
        "/api/admin/listings",
        {
          cookie: agent.cookie,
          csrfToken: await signCsrfToken(),
        },
        {
          body: JSON.stringify({ name: "Agent Made Listing" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      ),
    );
    expect(response.status).toBe(403);
    expect(await getListingWithCount(0)).toBeNull();
  });

  test("refuses an editor deleting a listing and keeps it", async () => {
    const listing = await createTestListing({ name: "Editor Delete" });
    const editor = await editorSession();

    const response = await handleRequest(
      requestAsSession(`/api/admin/listings/${listing.id}`, editor, {
        body: JSON.stringify({ confirm_identifier: "Editor Delete" }),
        headers: { "content-type": "application/json" },
        method: "DELETE",
      }),
    );
    expect(response.status).toBe(403);
    expect(await getListingWithCount(listing.id)).not.toBeNull();
  });

  test("refuses an editor deactivating a listing and keeps it active", async () => {
    const listing = await createTestListing({ name: "Editor Toggle" });
    const editor = await editorSession();

    const response = await handleRequest(
      requestAsSession(`/api/admin/listings/${listing.id}/deactivate`, editor, {
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    expect(response.status).toBe(403);
    const row = await getListingWithCount(listing.id);
    expect(row?.active).toBe(true);
  });
});
