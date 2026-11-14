/** Admin invoice preview page: the invoice the text makes and its update. */

import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settleAttendeeBalance } from "#db/attendees/balance.ts";
import { getDb } from "#db/client.ts";
import { settings } from "#db/settings.ts";
import { formatCurrency } from "#shared/currency.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { INVOICE_BODY_TEMPLATE } from "#templates/invoice/defaults.ts";
import {
  createOwing,
  pageText,
  previewedBody,
  previewInvoice,
} from "#test/features/admin/invoice-helpers.ts";
import {
  expectFlashRedirect,
  expectIncludesAll,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";
import { settingsAsStored } from "#test-utils/settings.ts";
import { regionOutOf } from "#test-utils/test-browser/parsing.ts";
import { sql } from "#db/sql.ts";

describeWithEnv("server (admin invoice preview)", { db: true }, () => {
  test("the preview shows the rendered invoice and the template it uses", async () => {
    const attendeeId = await createOwing(1500);
    const response = await previewInvoice(attendeeId, 1);
    const html = await pageText(response);

    expect(response.status).toBe(200);
    expectIncludesAll(html, [
      "Invoice preview",
      "<h1>Invoice 1</h1>",
      "Guest",
      "guest@example.com",
      `Amount due: ${formatCurrency(1500)}`,
      "{{ customer.name }}",
      "The site will not email this invoice. After you create it, share the link with your customer.",
    ]);
    // The preview stores nothing.
    assertStringIncludes(
      await pageText(await adminGet("/admin/invoices")),
      "No invoices yet.",
    );
  });

  test("the preview page keeps the invoice in its own box and offers an update", async () => {
    const attendeeId = await createOwing(1500);
    const html = await pageText(await previewInvoice(attendeeId, 1));

    const box = regionOutOf(
      html,
      '<div class="prose email-preview">',
      "</div>",
      "the invoice preview box",
    );
    expectIncludesAll(box, [
      "<h1>Invoice 1</h1>",
      `Amount due: ${formatCurrency(1500)}`,
    ]);
    assertStringIncludes(
      html,
      '<button class="secondary" formaction="/admin/invoices/preview" type="submit">Update preview</button>',
    );
  });

  test("Update preview shows the edited text and stores nothing", async () => {
    const attendeeId = await createOwing(1500);
    await previewInvoice(attendeeId, 1);
    const body =
      '# Thanks for booking\n\n{{ customer.name }} owes {{ totals.due | currency }}.\n\nTom & Jerry\'s "quote" <tag>';

    const response = await previewInvoice(attendeeId, 1, body);
    const html = await pageText(response);

    expect(response.status).toBe(200);
    expectIncludesAll(html, [
      "<h1>Thanks for booking</h1>",
      `owes ${formatCurrency(1500)}`,
    ]);
    expect(previewedBody(html)).toBe(body);
    assertStringIncludes(
      await pageText(await adminGet("/admin/invoices")),
      "No invoices yet.",
    );
    await settingsAsStored();
    expect(settings.invoiceBodyTemplate).toBe("");
  });

  test("Update preview with blank text offers the built-in text again", async () => {
    await settings.update.invoiceBodyTemplate("# Kept\n\n{{ customer.name }}");
    const attendeeId = await createOwing(1500);

    const html = await pageText(await previewInvoice(attendeeId, 1, ""));

    assertStringIncludes(html, "<h1>Invoice 1</h1>");
    expect(html).not.toContain("<h1>Kept</h1>");
    expect(previewedBody(html)).toBe(INVOICE_BODY_TEMPLATE);
    await settingsAsStored();
    expect(settings.invoiceBodyTemplate).toBe("# Kept\n\n{{ customer.name }}");
  });

  test("Update preview takes the longest text the field can carry", async () => {
    const attendeeId = await createOwing(1500);
    const body = "x".repeat(MAX_TEXTAREA_LENGTH);

    const response = await previewInvoice(attendeeId, 1, body);
    const html = await pageText(response);

    expect(response.status).toBe(200);
    expect(previewedBody(html)).toBe(body);
  });

  test("Update preview refuses invoice text that is too long", async () => {
    const attendeeId = await createOwing(1500);
    const response = await previewInvoice(
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

  test("refuses an attendee that does not exist", async () => {
    const response = await previewInvoice(999_999, 1);
    await expectFlashRedirect(
      "/admin/invoices/new",
      "That attendee does not exist.",
      false,
    )(response);
  });

  test("refuses a servicing attendee", async () => {
    const inserted = await getDb().execute(sql`INSERT INTO attendees (created, pii_blob, status_id, kind) VALUES (${new Date().toISOString()}, '', NULL, 'servicing')`);
    const response = await previewInvoice(Number(inserted.lastInsertRowid), 1);
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
    const response = await previewInvoice(attendeeId, 1);
    await expectFlashRedirect(
      "/admin/invoices/new",
      "This booking has no outstanding balance to invoice.",
      false,
    )(response);
  });

  test("refuses a blank form", async () => {
    const response = await adminFormPost("/admin/invoices/preview", {});
    await expectFlashRedirect(
      "/admin/invoices/new",
      "Enter the attendee number.",
      false,
    )(response.response);
  });
});
