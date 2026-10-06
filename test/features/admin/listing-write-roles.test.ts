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
  createTestManagerSession,
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
        // The create route answers through the post-write response path, so
        // the editor's money-free read applies here too.
        for (const field of ["cost", "income", "profit"]) {
          expect(field in body.listing).toBe(false);
        }
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
        for (const field of ["cost", "income", "profit"]) {
          expect(field in body.listing).toBe(false);
        }
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

  // The dashboard's editor form locks the webhook fields (parseListingForm:
  // the registration webhook posts full attendee PII to the URL) and offers no
  // active control (only staff deactivate or reactivate). The JSON body must
  // obey the same locks for editors, not silently accept the fields.
  test("freezes the webhook fields to stored values for an editor update", async () => {
    const listing = await createTestListing({
      name: "Editor Lock",
      useDefaults: false,
      webhookUrl: "https://hooks.example.com/stored",
    });
    const editor = await editorSession();

    const response = await handleRequest(
      requestAsSession(`/api/admin/listings/${listing.id}`, editor, {
        body: JSON.stringify({
          active: false,
          name: "Editor Lock Renamed",
          use_defaults: true,
          webhook_url: "https://editor.example/exfil",
        }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      }),
    );
    expect(response.status).toBe(200);

    const row = await getListingWithCount(listing.id);
    expect(row?.name).toBe("Editor Lock Renamed");
    expect(row?.active).toBe(true);
    expect(row?.use_defaults).toBe(false);
    expect(row?.webhook_url).toBe("https://hooks.example.com/stored");
  });

  test("ignores the locked fields for an editor create", async () => {
    const created = await assertJson<{
      listing: {
        active: boolean;
        id: number;
        use_defaults: boolean;
        webhook_url: string;
      };
    }>(
      handleRequest(
        requestAsSession("/api/admin/listings", await editorSession(), {
          body: JSON.stringify({
            active: false,
            listing_type: "standard",
            max_attendees: 10,
            name: "Editor Locked Create",
            use_defaults: true,
            webhook_url: "https://editor.example/exfil",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      ),
      201,
      (body) => {
        expect(body.listing.active).toBe(true);
        expect(body.listing.use_defaults).toBe(false);
        expect(body.listing.webhook_url).toBe("");
      },
    );
    expect(created.listing.id).toBeGreaterThan(0);
  });

  test("deactivates a normal listing through the update body for staff", async () => {
    const listing = await createTestListing({ name: "Manager Active Set" });
    const managerCookie = await createTestManagerSession();

    const response = await handleRequest(
      requestAsSession(
        `/api/admin/listings/${listing.id}`,
        {
          cookie: managerCookie,
          csrfToken: await signCsrfToken(),
        },
        {
          body: JSON.stringify({ active: false }),
          headers: { "content-type": "application/json" },
          method: "PUT",
        },
      ),
    );
    expect(response.status).toBe(200);
    const row = await getListingWithCount(listing.id);
    expect(row?.active).toBe(false);
  });

  // The dashboard's editor table is money-free (listing-table.tsx), so the
  // editor's API answers hide the staff-only money totals too.
  test("hides staff money totals from editor reads", async () => {
    const listing = await createTestListing({ name: "Editor Money Read" });
    const editor = await editorSession();

    const one = await handleRequest(
      requestAsSession(`/api/admin/listings/${listing.id}`, editor, {}),
    );
    const oneBody = await one.json();
    expect(one.status).toBe(200);
    expect(oneBody.listing).toBeDefined();
    for (const field of ["cost", "income", "profit"]) {
      expect(field in oneBody.listing).toBe(false);
    }

    const list = await handleRequest(
      requestAsSession("/api/admin/listings", editor, {}),
    );
    const listBody = await list.json();
    expect(list.status).toBe(200);
    for (const row of listBody.listings) {
      for (const field of ["cost", "income", "profit"]) {
        expect(field in row).toBe(false);
      }
    }
  });

  test("keeps staff money totals in staff reads", async () => {
    const listing = await createTestListing({ name: "Manager Money Read" });
    const managerCookie = await createTestManagerSession();

    const one = await handleRequest(
      requestAsSession(
        `/api/admin/listings/${listing.id}`,
        {
          cookie: managerCookie,
          csrfToken: await signCsrfToken(),
        },
        {},
      ),
    );
    const oneBody = await one.json();
    expect(one.status).toBe(200);
    expect(typeof oneBody.listing.income).toBe("number");
    expect(typeof oneBody.listing.cost).toBe("number");
    expect(typeof oneBody.listing.profit).toBe("number");
  });
});
