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
        // The editor's answer hides the locked fields (they are not settable
        // and not readable for the role), so the ignored submission is pinned
        // on the stored row instead.
        for (const field of ["use_defaults", "webhook_url"]) {
          expect(field in body.listing).toBe(false);
        }
      },
    );
    expect(created.listing.id).toBeGreaterThan(0);
    const row = await getListingWithCount(created.listing.id);
    expect(row?.webhook_url).toBe("");
    expect(row?.use_defaults).toBe(false);
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

  /** The row one editor/staff read answers with, after checking the status. */
  const readOne = async (
    id: number,
    session: { cookie: string; csrfToken: string },
  ): Promise<Record<string, unknown>> => {
    const one = await handleRequest(
      requestAsSession(`/api/admin/listings/${id}`, session, {}),
    );
    const oneBody = await one.json();
    expect(one.status).toBe(200);
    expect(oneBody.listing).toBeDefined();
    return oneBody.listing as Record<string, unknown>;
  };

  /** The rows one list read answers with, after checking the status. */
  const readList = async (session: {
    cookie: string;
    csrfToken: string;
  }): Promise<Record<string, unknown>[]> => {
    const list = await handleRequest(
      requestAsSession("/api/admin/listings", session, {}),
    );
    const listBody = await list.json();
    expect(list.status).toBe(200);
    return listBody.listings as Record<string, unknown>[];
  };

  /** Every named field sits outside the row. */
  const expectFieldsAbsent = (
    row: Record<string, unknown>,
    fields: readonly string[],
  ): void => {
    for (const field of fields) {
      expect(field in row).toBe(false);
    }
  };

  // The dashboard's editor table is money-free (listing-table.tsx), so the
  // editor's API answers hide the staff-only money totals too.
  test("hides staff money totals from editor reads", async () => {
    const listing = await createTestListing({ name: "Editor Money Read" });
    const editor = await editorSession();
    const moneyFields = ["cost", "income", "profit"] as const;

    expectFieldsAbsent(await readOne(listing.id, editor), moneyFields);
    for (const row of await readList(editor)) {
      expectFieldsAbsent(row, moneyFields);
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

  // The editor form hides webhook_url and use_defaults, and the write parser
  // freezes both: the stored webhook receives attendee PII and its URL can
  // carry credentials. The read answers hide the stored values too.
  test("hides locked webhook fields from editor answers", async () => {
    const listing = await createTestListing({
      name: "Editor Webhook Read",
      useDefaults: false,
      webhookUrl: "https://hooks.example.com/secret?token=t0k3n",
    });
    const editor = await editorSession();
    const lockedFields = ["webhook_url", "use_defaults"] as const;

    expectFieldsAbsent(await readOne(listing.id, editor), lockedFields);
    for (const row of await readList(editor)) {
      expectFieldsAbsent(row, lockedFields);
    }

    const created = await handleRequest(
      requestAsSession("/api/admin/listings", editor, {
        body: JSON.stringify({
          listing_type: "standard",
          max_attendees: 10,
          name: "Editor Webhook Made",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    const createdBody = await created.json();
    expect(created.status).toBe(201);
    expectFieldsAbsent(createdBody.listing, lockedFields);

    const updated = await handleRequest(
      requestAsSession(`/api/admin/listings/${listing.id}`, editor, {
        body: JSON.stringify({ name: "Editor Webhook Read Renamed" }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      }),
    );
    const updatedBody = await updated.json();
    expect(updated.status).toBe(200);
    expectFieldsAbsent(updatedBody.listing, lockedFields);

    // Staff keep the fields: the staff form edits the webhook.
    const managerCookie = await createTestManagerSession();
    const staffRow = await readOne(listing.id, {
      cookie: managerCookie,
      csrfToken: await signCsrfToken(),
    });
    expect(staffRow.webhook_url).toBe(
      "https://hooks.example.com/secret?token=t0k3n",
    );
    expect(staffRow.use_defaults).toBe(false);
  });
});
