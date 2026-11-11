/** Admin invoice routes: previewing, creating, viewing, cancelling, deleting. */

import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { createInvoice, nextInvoiceNumber } from "#db/invoices.ts";
import { settings } from "#db/settings.ts";
import { formatCurrency } from "#shared/currency.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import {
  expectFlashRedirect,
  expectIncludesAll,
  expectRedirect,
  inputNamed,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { configureTestEmail, emailTestSandbox } from "#test-utils/email.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import {
  adminFormPost,
  adminGet,
  createTestManagerSession,
  editorGetStatus,
  postFormAs,
} from "#test-utils/session.ts";
import { settingsAsStored } from "#test-utils/settings.ts";
import {
  createOwing,
  pageText,
  previewedBody,
  previewInvoice,
} from "./invoice-helpers.ts";

const CREATED = "2026-11-03T09:00:00.000Z";

const CREATED_FLASH = "The email did not send. Share the link instead.";

/** The second form step: store the invoice text the operator kept. */
const createInvoicePost = async (
  attendeeId: number,
  number: number,
  body: string,
): Promise<Response> =>
  (
    await adminFormPost("/admin/invoices/new", {
      attendee_id: String(attendeeId),
      body,
      number: String(number),
    })
  ).response;

/** Create one invoice through both form steps, land on the page it shows, and
 *  check the note the run expects. Returns the page path. */
const createInvoiceAndLand = async (
  attendeeId: number,
  number: number,
  note: string,
): Promise<string> => {
  const preview = await previewInvoice(attendeeId, number);
  expect(preview.status).toBe(200);
  const response = await createInvoicePost(
    attendeeId,
    number,
    previewedBody(await preview.text()),
  );
  const location = expectRedirect(
    response,
    new RegExp(`^/admin/invoices/${number}(\\?|$)`),
  );
  const path = new URL(location, "http://localhost").pathname;
  await expectFlashRedirect(path, note, true)(response);
  return path;
};

describeWithEnv("server (admin invoices)", { db: true }, () => {
  test("GET /admin/invoices starts empty", async () => {
    const html = await pageText(await adminGet("/admin/invoices"));
    expectIncludesAll(html, ["No invoices yet.", "Create invoice"]);
  });

  test("the create form prefills the next number and the attendee", async () => {
    const html = await pageText(
      await adminGet("/admin/invoices/new?attendee=42"),
    );
    expect(inputNamed(html, "number")).toContain('value="1"');
    expect(inputNamed(html, "attendee_id")).toContain('value="42"');
    expectIncludesAll(html, [
      "Preview invoice",
      // The first form only checks the booking; the preview page makes the
      // invoice.
      'action="/admin/invoices/preview"',
    ]);
  });

  test("a create stores the invoice and shows its frozen body", async () => {
    const attendeeId = await createOwing(1500);
    const path = await createInvoiceAndLand(
      attendeeId,
      1,
      `Invoice 1 created. ${CREATED_FLASH}`,
    );

    const html = await pageText(await adminGet(path));
    expectIncludesAll(html, [
      "Guest",
      "guest@example.com",
      "Invoice 1",
      "Amount due",
      "/invoice/",
      "New",
    ]);

    const list = await pageText(await adminGet("/admin/invoices"));
    expectIncludesAll(list, ["Guest", "New", 'href="/admin/invoices/1"']);
  });

  test("stores the invoice text the operator edited", async () => {
    const attendeeId = await createOwing(1500);
    expectRedirect(
      await createInvoicePost(attendeeId, 1, "# Thanks for booking\n\nPay us."),
      /^\/admin\/invoices\/1(\?|$)/,
    );

    const html = await pageText(await adminGet("/admin/invoices/1"));
    expectIncludesAll(html, ["<h1>Thanks for booking</h1>", "Pay us."]);
  });

  test("an empty text creates the invoice from the built-in text", async () => {
    await settings.update.invoiceBodyTemplate("# Kept\n\n{{ customer.name }}");
    const attendeeId = await createOwing(1500);
    expectRedirect(
      await createInvoicePost(attendeeId, 1, "   "),
      /^\/admin\/invoices\/1(\?|$)/,
    );

    const html = await pageText(await adminGet("/admin/invoices/1"));
    assertStringIncludes(html, "<h1>Invoice 1</h1>");
    await settingsAsStored();
    expect(settings.invoiceBodyTemplate).toBe("");
  });

  test("keeps a changed text for the next invoice", async () => {
    const template =
      "# Thanks\n\n{{ customer.name }} owes {{ totals.due | currency }}.";
    const attendeeId = await createOwing(1500);
    expectRedirect(
      await createInvoicePost(attendeeId, 1, template),
      /^\/admin\/invoices\/1(\?|$)/,
    );

    await settingsAsStored();
    expect(settings.invoiceBodyTemplate).toBe(template);

    const next = await createOwing(700);
    const html = await pageText(await previewInvoice(next, 2));
    expectIncludesAll(html, [
      "{{ customer.name }} owes",
      `owes ${formatCurrency(700)}`,
    ]);
  });

  test("does not keep the built-in text", async () => {
    const attendeeId = await createOwing(1500);
    const preview = await previewInvoice(attendeeId, 1);
    expectRedirect(
      await createInvoicePost(
        attendeeId,
        1,
        previewedBody(await preview.text()),
      ),
      /^\/admin\/invoices\/1(\?|$)/,
    );

    await settingsAsStored();
    expect(settings.invoiceBodyTemplate).toBe("");
  });

  test("refuses invoice text that is too long", async () => {
    const attendeeId = await createOwing(1500);
    const response = await createInvoicePost(
      attendeeId,
      1,
      "x".repeat(MAX_TEXTAREA_LENGTH + 1),
    );
    await expectFlashRedirect(
      "/admin/invoices/new",
      "The invoice text is too long. Shorten it and try again.",
      false,
    )(response);
  });

  test("refuses a second new invoice until the first is cancelled", async () => {
    const attendeeId = await createOwing(1500);
    expectRedirect(
      await createInvoicePost(attendeeId, 1, "Invoice one."),
      /^\/admin\/invoices\/1(\?|$)/,
    );

    const refused = await previewInvoice(attendeeId, 2);
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

    const created = await createInvoicePost(attendeeId, 2, "Invoice two.");
    expectRedirect(created, /^\/admin\/invoices\/2(\?|$)/);
  });

  test("refuses an invoice number that is taken", async () => {
    const first = await createOwing(1500);
    const second = await createOwing(1500);
    expectRedirect(
      await createInvoicePost(first, 1, "Invoice one."),
      /^\/admin\/invoices\/1(\?|$)/,
    );

    const response = await previewInvoice(second, 1);
    await expectFlashRedirect(
      "/admin/invoices/new",
      "That invoice number is already used. Choose another one.",
      false,
    )(response);
  });

  test("cancelling shows the cancelled status and refuses a second cancel", async () => {
    const attendeeId = await createOwing(1500);
    expectRedirect(
      await createInvoicePost(attendeeId, 1, "Invoice one."),
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
      await createInvoicePost(attendeeId, 1, "Invoice one."),
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

  test("a manager can preview, create, and view an invoice", async () => {
    const cookie = await createTestManagerSession();
    const attendeeId = await createOwing(1500);
    const preview = await postFormAs("/admin/invoices/preview", cookie, {
      attendee_id: String(attendeeId),
      number: "1",
    });
    expect(preview.status).toBe(200);
    assertStringIncludes(await preview.text(), "<h1>Invoice 1</h1>");

    const response = await postFormAs("/admin/invoices/new", cookie, {
      attendee_id: String(attendeeId),
      body: "Invoice one.",
      number: "1",
    });
    expectRedirect(response, /^\/admin\/invoices\/1(\?|$)/);

    const page = await awaitTestRequest("/admin/invoices/1", { cookie });
    expect(page.status).toBe(200);
    assertStringIncludes(await page.text(), "Invoice 1");
  });

  test("an editor cannot reach invoices", async () => {
    expect(await editorGetStatus("/admin/invoices")).toBe(403);
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

    test("the preview says the invoice will be emailed", async () => {
      await configureTestEmail();
      const attendeeId = await createOwing(1500);

      const html = await pageText(await previewInvoice(attendeeId, 1));

      assertStringIncludes(
        html,
        "This invoice will be emailed to guest@example.com when you create it.",
      );
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
      expectIncludesAll(body.html, ["/invoice/", "guest@example.com"]);
      assertStringIncludes(body.text, "Invoice 1 is ready.");
    });

    test("says the email did not send when the provider refuses it", async () => {
      await configureTestEmail();
      sandbox.stubFetch(() =>
        Promise.resolve(new Response(null, { status: 500 })),
      );
      const attendeeId = await createOwing(1500);

      const path = await createInvoiceAndLand(
        attendeeId,
        1,
        `Invoice 1 created. ${CREATED_FLASH}`,
      );

      // The note tells the operator to share the link, so the page carries it.
      assertStringIncludes(await pageText(await adminGet(path)), "/invoice/");
    });
  });
});
