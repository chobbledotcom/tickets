/** The public invoice share page: frozen body, live status, pay link. */

import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settleAttendeeBalance } from "#db/attendees/balance.ts";
import {
  cancelInvoice,
  createInvoice,
  nextInvoiceNumber,
} from "#db/invoices.ts";
import { handleRequest } from "#routes";
import { formatCurrency } from "#shared/currency.ts";
import { insertBareAttendee } from "#test/integration/balance-helpers.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { createReservedAttendee } from "#test-utils/balance.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockRequest } from "#test-utils/mocks.ts";

const CREATED = "2026-11-03T09:00:00.000Z";

const shareInvoice = async (
  attendeeId: number,
  bodyHtml = "<p>Frozen body</p>",
): Promise<{ id: number; shareToken: string }> => {
  const id = await nextInvoiceNumber();
  const { invoice, shareToken } = await createInvoice({
    attendeeId,
    bodyHtml,
    created: CREATED,
    id,
  });
  return { id: invoice.id, shareToken };
};

const getShare = (token: string): Promise<Response> =>
  handleRequest(mockRequest(`/invoice/${token}`));

describeWithEnv("server (public invoice page)", { db: true }, () => {
  test("shows the frozen body, the status, and a pay form", async () => {
    const { attendeeId } = await createReservedAttendee(1500);
    const { shareToken } = await shareInvoice(attendeeId);

    const response = await getShare(shareToken);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const html = await response.text();
    expectIncludesAll(html, [
      "Frozen body",
      "Status: New",
      // The same pay button the balance page renders, with the amount it charges.
      `Pay ${formatCurrency(1500)} now`,
      'action="/pay/bal1.',
      'class="inline"',
    ]);
    // The frozen body owns the page's headings, so the page adds none.
    expect(html).not.toContain("<h1>");
  });

  test("stops offering payment once the balance is paid", async () => {
    const { attendeeId } = await createReservedAttendee(1500);
    const { shareToken } = await shareInvoice(attendeeId);
    await settleAttendeeBalance(attendeeId, 1500, {
      id: "invoice-share-settle",
      occurredAt: CREATED,
    });

    const html = await (await getShare(shareToken)).text();

    assertStringIncludes(html, "Status: Paid");
    expect(html).not.toContain("Pay ");
  });

  test("shows a cancelled invoice without a pay form", async () => {
    const { attendeeId } = await createReservedAttendee(1500);
    const { id, shareToken } = await shareInvoice(attendeeId);
    await cancelInvoice(id);

    const html = await (await getShare(shareToken)).text();

    assertStringIncludes(html, "Status: Cancelled");
    expect(html).not.toContain(`action="/pay/`);
  });

  test("a new invoice with nothing owing offers no payment", async () => {
    const attendeeId = await insertBareAttendee(null, 0);
    const { shareToken } = await shareInvoice(attendeeId);

    const html = await (await getShare(shareToken)).text();

    assertStringIncludes(html, "Status: New");
    expect(html).not.toContain(`action="/pay/`);
  });

  test("an unknown token is not found", async () => {
    expect((await getShare("not-a-real-token")).status).toBe(404);
  });

  test("an empty token is not found", async () => {
    expect((await handleRequest(mockRequest("/invoice/"))).status).toBe(404);
  });

  test("an invoice whose attendee is gone is not found", async () => {
    const { shareToken } = await shareInvoice(999_999);

    expect((await getShare(shareToken)).status).toBe(404);
  });
});
