import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { postTransfers } from "#shared/accounting/store.ts";
import { adjustListingIncome } from "#shared/db/listings.ts";
import { modifiersTable } from "#shared/db/modifiers.ts";
import { account } from "#shared/ledger/account.ts";
import type { TransferInput } from "#shared/ledger/types.ts";
import {
  adminGet,
  awaitTestRequest,
  createTestAttendee,
  createTestListing,
  createTestManagerSession,
  describeWithEnv,
  testRequiresAuth,
} from "#test-utils";
import {
  postAttendeeRefund,
  postListingSale,
  postModifierLeg,
} from "#test-utils/ledger.ts";

/** Seed a listing + a registered attendee, then post a fully-paid sale so the
 * ledger holds an `attendee:<id>` ↔ `revenue:<listing>` pair plus a payment. */
const seededSale = async (
  name = "Summer Concert",
  gross = 2500,
): Promise<{ attendeeId: number; listingId: number }> => {
  const listing = await createTestListing({
    maxAttendees: 10,
    name,
    thankYouUrl: "https://example.com",
  });
  const attendee = await createTestAttendee(
    listing.id,
    listing.slug,
    "Ada Lovelace",
    "ada@example.com",
  );
  await postListingSale({
    attendeeId: attendee.id,
    gross,
    listingId: listing.id,
  });
  return { attendeeId: attendee.id, listingId: listing.id };
};

describeWithEnv("server (admin ledger)", { db: true }, () => {
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
    const { response } = await adminGet("/admin/ledger");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Ledger");
    // The sale leg credits the listing's revenue account, linked by its name.
    expect(html).toContain("Summer Concert");
    expect(html).toContain("/admin/listing/");
    // The attendee leg resolves to a link too (name decrypted with the key).
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("/admin/attendees/");
    // Kinds from the mapped booking show in the Event column.
    expect(html).toContain("sale");
  });

  test("shows the empty state when no transfers exist", async () => {
    const { response } = await adminGet("/admin/ledger");
    const html = await response.text();
    expect(html).toContain("No transfers recorded yet");
  });

  test("surfaces the 'showing recent' note past the 500-transfer display cap", async () => {
    const { attendeeId, listingId } = await seededSale();
    // One big event whose many legs (each a distinct reference) push the ledger
    // past the 500-transfer recent-window cap, so the "showing recent" note must
    // appear. 501 extra legs clears the cap regardless of the seeded sale's few.
    const extras: TransferInput[] = [];
    for (let i = 0; i < 501; i++) {
      extras.push({
        amount: 100,
        destination: account("revenue", listingId),
        eventGroup: "bulk",
        kind: "sale",
        occurredAt: "2026-06-20T00:00:00.000Z",
        reference: `bulk-${i}`,
        source: account("attendee", attendeeId),
      });
    }
    await postTransfers(extras);
    const { response } = await adminGet("/admin/ledger");
    const html = await response.text();
    expect(html).toContain("Showing the most recent 500 transfers");
  });

  test("renders an account statement with a running balance", async () => {
    const { attendeeId } = await seededSale("Gala", 2500);
    const { response } = await adminGet(`/admin/ledger/attendee/${attendeeId}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Account statement");
    // The attendee's own label heads the page; a fully-paid sale nets to zero.
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("Balance:");
    expect(html).toContain("<th>Balance</th>");
    // The sale's counterparty is the listing revenue account, linked by name.
    expect(html).toContain("Gala");
  });

  test("renders a revenue listing's statement", async () => {
    const { listingId } = await seededSale("Workshop", 4000);
    const { response } = await adminGet(`/admin/ledger/revenue/${listingId}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Workshop");
    // The counterparty of the sale leg is the paying attendee.
    expect(html).toContain("Ada Lovelace");
  });

  test("resolves a real modifier's name and links its leg to the edit page", async () => {
    // A real modifier row exists, so the historical list resolves its name and
    // links the modifier leg to /admin/modifiers/<id>/edit.
    const modifier = await modifiersTable.insert({
      calcKind: "fixed",
      calcValue: 500,
      direction: "charge",
      name: "Booking surcharge",
    });
    await postModifierLeg({ delta: 500, modifierId: modifier.id });
    const { response } = await adminGet("/admin/ledger");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Booking surcharge");
    expect(html).toContain(`/admin/modifiers/${modifier.id}/edit`);
  });

  test("falls back to 'Modifier #<id>' when no modifier row exists", async () => {
    await postModifierLeg({ delta: 500, modifierId: 1 });
    const { response } = await adminGet("/admin/ledger/modifier/1");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Account statement");
    // No modifier row exists, so the account falls back to "Modifier #1".
    expect(html).toContain("Modifier #1");
  });

  test("renders the singleton card/bank statement", async () => {
    await seededSale();
    const { response } = await adminGet("/admin/ledger/external/world");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Card / bank");
  });

  test("renders the booking-fee income statement", async () => {
    // A booking-fee leg lands on fee_income:booking via a real refund's reversal
    // is not needed — just assert the singleton page renders for the account.
    const { response } = await adminGet("/admin/ledger/fee_income/booking");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Booking fees");
  });

  test("renders the writeoff contra-revenue statement", async () => {
    // A manual income correction posts a leg against writeoff:default, so its
    // statement must resolve (the singleton's label is admin.ledger.account.writeoff).
    const listing = await createTestListing({
      maxAttendees: 10,
      name: "Adjusted",
      thankYouUrl: "https://example.com",
    });
    await adjustListingIncome(listing.id, 0, 1500);
    const { response } = await adminGet("/admin/ledger/writeoff/default");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Account statement");
    // The writeoff singleton renders its label, not a raw "writeoff:default".
    expect(html).toContain("Write-off");
    // The correction's counterparty is the listing's revenue account.
    expect(html).toContain("Adjusted");
  });

  test("includes a refunded attendee's reversal legs in their statement", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      name: "Refundable",
      thankYouUrl: "https://example.com",
    });
    const attendee = await createTestAttendee(
      listing.id,
      listing.slug,
      "Grace Hopper",
      "grace@example.com",
    );
    await postAttendeeRefund({
      attendeeId: attendee.id,
      listingId: listing.id,
    });
    const { response } = await adminGet(
      `/admin/ledger/attendee/${attendee.id}`,
    );
    const html = await response.text();
    expect(html).toContain("Grace Hopper");
    // A full refund nets to zero, so the final running balance is zero.
    expect(html).toContain("Balance:");
  });

  test("404s on an unknown account type", async () => {
    const { response } = await adminGet("/admin/ledger/nonsense/1");
    expect(response.status).toBe(404);
  });

  test("404s on a non-positive row id", async () => {
    const { response } = await adminGet("/admin/ledger/attendee/0");
    expect(response.status).toBe(404);
  });
});
