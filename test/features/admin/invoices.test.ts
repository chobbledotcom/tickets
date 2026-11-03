/** Admin invoice routes: creating, viewing, cancelling, and deleting. */

import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { settleAttendeeBalance } from "#db/attendees/balance.ts";
import { getDb } from "#db/client.ts";
import { createInvoice, nextInvoiceNumber } from "#db/invoices.ts";
import {
  expectFlashRedirect,
  expectRedirect,
  inputNamed,
} from "#test-utils/assertions.ts";
import { createReservedAttendee } from "#test-utils/balance.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { configureTestEmail, emailTestSandbox } from "#test-utils/email.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import {
  adminFormPost,
  adminGet,
  createTestEditorSession,
  createTestManagerSession,
  postFormAs,
} from "#test-utils/session.ts";

const CREATED = "2026-11-03T09:00:00.000Z";

const CREATED_FLASH = "The email did not send. Share the link instead.";

const postNewInvoice = async (
  attendeeId: number,
  number: number,
): Promise<Response> =>
  (
    await adminFormPost("/admin/invoices/new", {
      attendee_id: String(attendeeId),
      number: String(number),
    })
  ).response;

/** Create one invoice through the form, land on the page it shows, and check
 *  the note the run expects. Returns the page path. */
const createInvoiceAndLand = async (
  attendeeId: number,
  number: number,
  note: string,
): Promise<string> => {
  const response = await postNewInvoice(attendeeId, number);
  const location = expectRedirect(
    response,
    new RegExp(`^/admin/invoices/${number}(\\?|$)`),
  );
  const path = new URL(location, "http://localhost").pathname;
  await expectFlashRedirect(path, note, true)(response);
  return path;
};

const pageText = async (response: Response): Promise<string> =>
  await response.text();

const createOwing = async (amount: number): Promise<number> =>
  (await createReservedAttendee(amount)).attendeeId;

describeWithEnv("server (admin invoices)", { db: true }, () => {
  test("GET /admin/invoices starts empty", async () => {
    const html = await pageText(await adminGet("/admin/invoices"));
    assertStringIncludes(html, "No invoices yet.");
    assertStringIncludes(html, "Create invoice");
  });

  test("the create form prefills the next number and the attendee", async () => {
    const html = await pageText(
      await adminGet("/admin/invoices/new?attendee=42"),
    );
    expect(inputNamed(html, "number")).toContain('value="1"');
    expect(inputNamed(html, "attendee_id")).toContain('value="42"');
  });

  test("a create stores the invoice and shows its frozen body", async () => {
    const attendeeId = await createOwing(1500);
    const path = await createInvoiceAndLand(
      attendeeId,
      1,
      `Invoice 1 created. ${CREATED_FLASH}`,
    );

    const html = await pageText(await adminGet(path));
    assertStringIncludes(html, "Guest");
    assertStringIncludes(html, "guest@example.com");
    assertStringIncludes(html, "Invoice 1");
    assertStringIncludes(html, "Amount due");
    assertStringIncludes(html, "/invoice/");
    assertStringIncludes(html, "New");

    const list = await pageText(await adminGet("/admin/invoices"));
    assertStringIncludes(list, "Guest");
    assertStringIncludes(list, "New");
    assertStringIncludes(list, 'href="/admin/invoices/1"');
  });

  test("refuses an attendee that does not exist", async () => {
    const response = await postNewInvoice(999_999, 1);
    await expectFlashRedirect(
      "/admin/invoices/new",
      "That attendee does not exist.",
      false,
    )(response);
  });

  test("refuses a servicing attendee", async () => {
    const inserted = await getDb().execute({
      args: [new Date().toISOString()],
      sql: "INSERT INTO attendees (created, pii_blob, status_id, kind) VALUES (?, '', NULL, 'servicing')",
    });
    const response = await postNewInvoice(Number(inserted.lastInsertRowid), 1);
    await expectFlashRedirect(
      "/admin/invoices/new",
      "That attendee does not exist.",
      false,
    )(response);
  });

  test("refuses an attendee with nothing owing", async () => {
    const attendeeId = await createOwing(1500);
    await settleAttendeeBalance(attendeeId, 1500, {
      id: "invoice-nothing-due",
      occurredAt: "2026-11-03T00:00:00.000Z",
    });
    const response = await postNewInvoice(attendeeId, 1);
    await expectFlashRedirect(
      "/admin/invoices/new",
      "This booking has no outstanding balance to invoice.",
      false,
    )(response);
  });

  test("refuses a second new invoice until the first is cancelled", async () => {
    const attendeeId = await createOwing(1500);
    expectRedirect(
      await postNewInvoice(attendeeId, 1),
      /^\/admin\/invoices\/1(\?|$)/,
    );

    const refused = await postNewInvoice(attendeeId, 2);
    await expectFlashRedirect(
      "/admin/invoices/new",
      "This attendee has a new invoice. Cancel that invoice before you create another one.",
      false,
    )(refused);

    const cancelled = await adminFormPost("/admin/invoices/1/cancel", {});
    await expectFlashRedirect(
      "/admin/invoices/1",
      "Invoice 1 cancelled.",
      true,
    )(cancelled.response);

    const created = await postNewInvoice(attendeeId, 2);
    expectRedirect(created, /^\/admin\/invoices\/2(\?|$)/);
  });

  test("refuses an invoice number that is taken", async () => {
    const first = await createOwing(1500);
    const second = await createOwing(1500);
    expectRedirect(
      await postNewInvoice(first, 1),
      /^\/admin\/invoices\/1(\?|$)/,
    );

    const response = await postNewInvoice(second, 1);
    await expectFlashRedirect(
      "/admin/invoices/new",
      "That invoice number is already used. Choose another one.",
      false,
    )(response);
  });

  test("cancelling shows the cancelled status and refuses a second cancel", async () => {
    const attendeeId = await createOwing(1500);
    expectRedirect(
      await postNewInvoice(attendeeId, 1),
      /^\/admin\/invoices\/1(\?|$)/,
    );
    await adminFormPost("/admin/invoices/1/cancel", {});

    const html = await pageText(await adminGet("/admin/invoices/1"));
    assertStringIncludes(html, "Cancelled");
    expect(html).not.toContain("Cancel invoice");

    const again = await adminFormPost("/admin/invoices/1/cancel", {});
    await expectFlashRedirect(
      "/admin/invoices/1",
      "Only a new invoice can be cancelled.",
      false,
    )(again.response);
  });

  test("deleting an invoice returns to an empty list", async () => {
    const attendeeId = await createOwing(1500);
    expectRedirect(
      await postNewInvoice(attendeeId, 1),
      /^\/admin\/invoices\/1(\?|$)/,
    );

    const response = await adminFormPost("/admin/invoices/1/delete", {});
    await expectFlashRedirect(
      "/admin/invoices",
      "Invoice 1 deleted.",
      true,
    )(response.response);
    assertStringIncludes(
      await pageText(await adminGet("/admin/invoices")),
      "No invoices yet.",
    );
  });

  test("a manager can create and view an invoice", async () => {
    const cookie = await createTestManagerSession();
    const attendeeId = await createOwing(1500);
    const response = await postFormAs("/admin/invoices/new", cookie, {
      attendee_id: String(attendeeId),
      number: "1",
    });
    expectRedirect(response, /^\/admin\/invoices\/1(\?|$)/);

    const page = await awaitTestRequest("/admin/invoices/1", { cookie });
    expect(page.status).toBe(200);
    assertStringIncludes(await page.text(), "Invoice 1");
  });

  test("an editor cannot reach invoices", async () => {
    const editor = await createTestEditorSession();
    const response = await awaitTestRequest("/admin/invoices", {
      cookie: editor.cookie,
    });
    expect(response.status).toBe(403);
  });

  test("refuses a blank form", async () => {
    const response = await adminFormPost("/admin/invoices/new", {});
    await expectFlashRedirect(
      "/admin/invoices/new",
      "Enter the attendee number.",
      false,
    )(response.response);
  });

  test("an unknown invoice is not found for view, cancel, or delete", async () => {
    expect((await adminGet("/admin/invoices/999")).status).toBe(404);
    expect(
      (await adminFormPost("/admin/invoices/999/cancel", {})).response.status,
    ).toBe(404);
    expect(
      (await adminFormPost("/admin/invoices/999/delete", {})).response.status,
    ).toBe(404);
  });

  test("an invoice whose attendee is gone is not found", async () => {
    const { invoice } = await createInvoice({
      attendeeId: 999_999,
      bodyHtml: "<p>Orphan</p>",
      created: CREATED,
      id: await nextInvoiceNumber(),
    });

    expect((await adminGet(`/admin/invoices/${invoice.id}`)).status).toBe(404);

    const list = await pageText(await adminGet("/admin/invoices"));
    assertStringIncludes(list, `href="/admin/invoices/${invoice.id}"`);
    expect(list).not.toContain("Guest");
  });

  describe("email", () => {
    const sandbox = emailTestSandbox();

    afterEach(() => {
      sandbox.teardown();
    });

    test("sends the invoice to the buyer with its share link", async () => {
      await configureTestEmail();
      const captured = sandbox.captureFetchCall();
      const attendeeId = await createOwing(1500);

      await createInvoiceAndLand(
        attendeeId,
        1,
        "Invoice 1 created and emailed.",
      );

      expect(captured.url).toBe("https://api.resend.com/emails");
      const body = captured.body as {
        html: string;
        subject: string;
        text: string;
        to: string[];
      };
      expect(body.to).toEqual(["guest@example.com"]);
      expect(body.subject).toBe("Invoice 1");
      assertStringIncludes(body.html, "/invoice/");
      assertStringIncludes(body.html, "guest@example.com");
      assertStringIncludes(body.text, "Invoice 1 is ready.");
    });

    test("says the email did not send when the provider refuses it", async () => {
      await configureTestEmail();
      sandbox.stubFetch(() =>
        Promise.resolve(new Response(null, { status: 500 })),
      );
      const attendeeId = await createOwing(1500);

      await createInvoiceAndLand(
        attendeeId,
        1,
        `Invoice 1 created. ${CREATED_FLASH}`,
      );
    });
  });
});
