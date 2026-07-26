import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { postTransfers } from "#shared/accounting/store.ts";
import { modifiersTable } from "#shared/db/modifiers.ts";
import { account } from "#shared/ledger/account.ts";
import type { TransferInput } from "#shared/ledger/types.ts";
import { ledgerPageHtml, seededSale } from "#test/lib/server-ledger/helpers.ts";
import { testRequiresAuth } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { postModifierLeg } from "#test-utils/ledger.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import { adminGet, createTestManagerSession } from "#test-utils/session.ts";

describeWithEnv("server (admin ledger list views)", { db: true }, () => {
  testRequiresAuth("/admin/ledger");
  testRequiresAuth("/admin/ledger/attendee/1");

  test("is owner-only — a manager is forbidden", async () => {
    const response = await awaitTestRequest("/admin/ledger", {
      cookie: await createTestManagerSession(),
    });
    expect(response.status).toBe(403);
  });

  test("renders recent transfers with the listing name resolved as a link", async () => {
    await seededSale("Summer Concert", 2500);
    const html = await ledgerPageHtml("/admin/ledger?view=dual");
    // The sale leg credits the listing's revenue account, linked by its name.
    expect(html).toContain("Summer Concert");
    expect(html).toContain("/admin/ledger?listing=");
    // The attendee leg resolves to a link too (name decrypted with the key).
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("/admin/ledger/attendee/");
    expect(html).toContain("<td>Booking made</td>");
    expect(html).not.toContain("<td>sale</td>");
  });

  test("shows the empty state when no transfers exist", async () => {
    const response = await adminGet("/admin/ledger?view=dual");
    const html = await response.text();
    expect(html).toContain("No money changes yet.");
  });

  test("hides the external 'Card / bank' cash legs from the transfer list", async () => {
    // A fully-paid sale posts a payment leg (world → attendee). That cash leg is
    // hidden, so the only place "Card / bank" could appear — an external leg row —
    // is gone from the list page entirely.
    await seededSale("Gala", 2500);
    const response = await adminGet("/admin/ledger?view=dual");
    const html = await response.text();
    expect(html).toContain("<td>Booking made</td>");
    expect(html).not.toContain("Card / bank");
  });

  test("defaults the bare ledger page to the human view", async () => {
    await seededSale("Gala", 2500);
    const response = await adminGet("/admin/ledger");
    const html = await response.text();
    expect(html).toContain("<th>Activity</th>");
    expect(html).toContain("<strong>Simple view</strong>");
    expect(html).toContain("booked");
    expect(html).toContain("Gala");
    expect(html).not.toContain("<th>Event</th>");
    expect(html).not.toContain("<td>sale</td>");
  });

  test("resolves a real modifier's name and links its leg to its Money page", async () => {
    // A real modifier row exists, so the historical list resolves its name and
    // links the modifier leg to /admin/modifiers/<id>/edit.
    const modifier = await modifiersTable.insert({
      calcKind: "fixed",
      calcValue: 500,
      direction: "charge",
      name: "Booking surcharge",
    });
    await postModifierLeg({ delta: 500, modifierId: modifier.id });
    const response = await adminGet("/admin/ledger");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Booking surcharge");
    expect(html).toContain(`/admin/ledger/modifier/${modifier.id}`);
  });

  /** The event label every bulk leg renders, used to count visible rows. */
  const BULK_KIND = "sale";
  const BULK_EVENT_LABEL = "Booking made";
  const EXPECTED_DISPLAY_CAP = 500;

  /** Post exactly `count` distinct ledger legs (each a unique reference), then
   * GET the historical ledger page. Self-contained — uses fixed account ids so
   * the total leg count is exactly `count`, independent of any other seeding. */
  const postBulkLegsAndGet = async (count: number): Promise<string> => {
    const extras: TransferInput[] = [];
    for (let i = 0; i < count; i++) {
      extras.push({
        amount: 100,
        destination: account("revenue", 1),
        eventGroup: "bulk",
        kind: BULK_KIND,
        occurredAt: "2026-06-20T00:00:00.000Z",
        reference: `bulk-${i}`,
        source: account("attendee", 1),
      });
    }
    await postTransfers(extras);
    const response = await adminGet("/admin/ledger?view=dual");
    return response.text();
  };

  /** Count rendered rows by their event cell. */
  const renderedRowCount = (html: string): number =>
    html.split(`<td>${BULK_EVENT_LABEL}</td>`).length - 1;

  test("renders at most the display cap and surfaces the 'showing recent' note past it", async () => {
    // One more leg than the cap: the SQL LIMIT (cap + 1) returns the extra row,
    // so truncation is detected — the note shows and only the cap is rendered,
    // never the whole ledger.
    const html = await postBulkLegsAndGet(EXPECTED_DISPLAY_CAP + 1);
    expect(html).toContain("Showing the 500 most recent money changes.");
    expect(renderedRowCount(html)).toBe(EXPECTED_DISPLAY_CAP);
  });

  test("renders every row and omits the note when exactly the display cap exist", async () => {
    // Exactly the cap: the LIMIT (cap + 1) returns no extra row, so no
    // truncation note, and all cap rows render.
    const html = await postBulkLegsAndGet(EXPECTED_DISPLAY_CAP);
    expect(html).not.toContain("Showing the 500 most recent money changes.");
    expect(renderedRowCount(html)).toBe(EXPECTED_DISPLAY_CAP);
  });
});
