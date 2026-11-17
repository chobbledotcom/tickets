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

type ApiSession = { cookie: string; csrfToken: string };

/** One JSON write through the listings API as the session. */
const jsonWrite = (
  session: ApiSession,
  method: "DELETE" | "POST" | "PUT",
  path: string,
  body: Record<string, unknown>,
): Promise<Response> =>
  handleRequest(
    requestAsSession(path, session, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method,
    }),
  );

describeWithEnv("Admin API - Listings role parity", { db: true }, () => {
  const editorSession = async (): Promise<{
    cookie: string;
    csrfToken: string;
  }> => ({
    cookie: (await createTestEditorSession()).cookie,
    csrfToken: await signCsrfToken(),
  });

  /** The write answers with the named listing and no money totals. */
  const expectMoneyFreeAnswer = (
    written: Promise<Response>,
    status: number,
    name: string,
  ) =>
    assertJson(written, status, (body) => {
      expect(body.listing.name).toBe(name);
      for (const field of ["cost", "income", "profit"]) {
        expect(field in body.listing).toBe(false);
      }
    });

  test("admits an editor creating a listing", async () => {
    // The create route answers through the post-write response path, so the
    // editor's money-free read applies here too.
    await expectMoneyFreeAnswer(
      jsonWrite(await editorSession(), "POST", "/api/admin/listings", {
        listing_type: "standard",
        max_attendees: 10,
        name: "Editor Made Listing",
      }),
      201,
      "Editor Made Listing",
    );
  });

  test("admits an editor updating a listing", async () => {
    const listing = await createTestListing({ name: "Editor Edit" });
    const editor = await editorSession();

    await expectMoneyFreeAnswer(
      jsonWrite(editor, "PUT", `/api/admin/listings/${listing.id}`, {
        name: "Editor Renamed",
      }),
      200,
      "Editor Renamed",
    );
  });

  test("refuses an agent with 403 and creates nothing", async () => {
    const agent = await createTestAgentSession();
    const response = await jsonWrite(
      { cookie: agent.cookie, csrfToken: await signCsrfToken() },
      "POST",
      "/api/admin/listings",
      { name: "Agent Made Listing" },
    );
    expect(response.status).toBe(403);
    expect(await getListingWithCount(0)).toBeNull();
  });

  test("refuses an editor deleting a listing and keeps it", async () => {
    const listing = await createTestListing({ name: "Editor Delete" });
    const editor = await editorSession();

    const response = await jsonWrite(
      editor,
      "DELETE",
      `/api/admin/listings/${listing.id}`,
      { confirm_identifier: "Editor Delete" },
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
  test("refuses an editor update that names a locked field, and changes nothing", async () => {
    const listing = await createTestListing({
      name: "Editor Lock",
      webhookUrl: "https://hooks.example.com/stored",
    });
    const editor = await editorSession();

    const response = await jsonWrite(
      editor,
      "PUT",
      `/api/admin/listings/${listing.id}`,
      {
        name: "Editor Lock Renamed",
        webhook_url: "https://editor.example/exfil",
      },
    );

    const row = await getListingWithCount(listing.id);
    expect([
      response.status,
      await response.json(),
      row?.name,
      row?.webhookUrl,
    ]).toEqual([
      400,
      { error: "editors cannot set webhook_url" },
      "Editor Lock",
      "https://hooks.example.com/stored",
    ]);
  });

  test("refuses an editor create that names a locked field", async () => {
    const response = await jsonWrite(
      await editorSession(),
      "POST",
      "/api/admin/listings",
      {
        active: true,
        listing_type: "standard",
        max_attendees: 10,
        name: "Editor Locked Create",
      },
    );

    expect([response.status, await response.json()]).toEqual([
      400,
      { error: "editors cannot set active" },
    ]);
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
    expect(oneBody.listing).toMatchObject({ id });
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

    const created = await jsonWrite(editor, "POST", "/api/admin/listings", {
      listing_type: "standard",
      max_attendees: 10,
      name: "Editor Webhook Made",
    });
    const createdBody = await created.json();
    expect(created.status).toBe(201);
    expectFieldsAbsent(createdBody.listing, lockedFields);

    const updated = await jsonWrite(
      editor,
      "PUT",
      `/api/admin/listings/${listing.id}`,
      { name: "Editor Webhook Read Renamed" },
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
