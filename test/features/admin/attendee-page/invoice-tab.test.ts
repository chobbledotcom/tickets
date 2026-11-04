/** The attendee page's Invoice tab, and the links that start an invoice. */

import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { createInvoice, nextInvoiceNumber } from "#db/invoices.ts";
import { createReservedAttendee } from "#test-utils/balance.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee, renderTab, tabHtml } from "./helpers.ts";

const CREATED = "2026-11-04T09:00:00.000Z";

/** Store one invoice for the attendee, as a create would. */
const addInvoice = async (attendeeId: number): Promise<number> => {
  const { invoice } = await createInvoice({
    attendeeId,
    bodyHtml: "<h1>Invoice</h1>",
    created: CREATED,
    id: await nextInvoiceNumber(),
  });
  return invoice.id;
};

describeWithEnv("the attendee page's invoices", { db: true }, () => {
  test("offers no Invoice tab to an attendee with none", async () => {
    const id = await bookAttendee();
    assert(!(await tabHtml(id, "")).includes(`/admin/attendees/${id}/invoice`));
  });

  test("an Invoice tab named directly for an attendee with none is not found", async () => {
    const response = await renderTab(await bookAttendee(), "invoice");
    expect(response.status).toBe(404);
  });

  test("offers the Invoice tab, naming the status, once one exists", async () => {
    const id = await bookAttendee();
    const invoiceId = await addInvoice(id);

    assertStringIncludes(
      await tabHtml(id, ""),
      `/admin/attendees/${id}/invoice`,
    );

    const tab = await tabHtml(id, "invoice");
    assertStringIncludes(tab, `href="/admin/invoices/${invoiceId}"`);
    assertStringIncludes(tab, "New");
  });

  test("offers Create invoice on the Actions tab", async () => {
    const id = await bookAttendee();

    const html = await tabHtml(id, "actions");

    assertStringIncludes(html, `href="/admin/invoices/new?attendee=${id}"`);
    assertStringIncludes(html, "Create invoice");
  });

  test("hides Create invoice while a new invoice exists", async () => {
    const id = await bookAttendee();
    await addInvoice(id);

    assert(
      !(await tabHtml(id, "actions")).includes(
        `/admin/invoices/new?attendee=${id}`,
      ),
    );
  });

  test("offers Create invoice on the Money tab for an outstanding balance", async () => {
    const { attendeeId } = await createReservedAttendee(1500);

    const html = await tabHtml(attendeeId, "ledger");

    assertStringIncludes(
      html,
      `href="/admin/invoices/new?attendee=${attendeeId}"`,
    );
  });

  test("hides the Money tab's Create invoice while a new invoice exists", async () => {
    const { attendeeId } = await createReservedAttendee(1500);
    await addInvoice(attendeeId);

    assert(
      !(await tabHtml(attendeeId, "ledger")).includes(
        `/admin/invoices/new?attendee=${attendeeId}`,
      ),
    );
  });
});
