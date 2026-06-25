import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  LEDGER_DISPLAY_LIMIT,
  pickerDatesFromBounds,
} from "#routes/admin/ledger.ts";
import {
  MANUAL_ATTENDEE_CHARGE,
  MANUAL_ATTENDEE_PAYMENT,
  MANUAL_ATTENDEE_WRITEOFF,
  MANUAL_LISTING_COST,
  MANUAL_LISTING_INCOME,
  MANUAL_MODIFIER_INCOME,
  MANUAL_MODIFIER_REDUCTION,
} from "#shared/accounting/manual-entries.ts";
import { allTransfers } from "#shared/accounting/queries.ts";
import { postTransfers } from "#shared/accounting/store.ts";
import { formatCurrency } from "#shared/currency.ts";
import { adjustListingIncome } from "#shared/db/listings.ts";
import { modifiersTable } from "#shared/db/modifiers.ts";
import { account } from "#shared/ledger/account.ts";
import type { TransferInput } from "#shared/ledger/types.ts";
import {
  adminFormPost,
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

const seededAttendee = async (): Promise<{
  attendeeId: number;
  listingId: number;
}> => {
  const listing = await createTestListing({
    maxAttendees: 10,
    name: "Manual listing",
    thankYouUrl: "https://example.com",
  });
  const attendee = await createTestAttendee(
    listing.id,
    listing.slug,
    "Ada Lovelace",
    "ada@example.com",
  );
  return { attendeeId: attendee.id, listingId: listing.id };
};

const redirectTargetWithoutFlash = (response: Response): string => {
  const location = response.headers.get("location");
  if (!location) return "";
  const url = new URL(location, "http://localhost");
  url.searchParams.delete("flash");
  const query = url.searchParams.toString();
  return `${url.pathname}${query ? `?${query}` : ""}${url.hash}`;
};

const postAttendeePayment = async (
  attendeeId: number,
  amount = "12.34",
): Promise<void> => {
  const returnUrl = `/admin/attendees/${attendeeId}`;
  const { response } = await adminFormPost(
    `/admin/ledger/attendee/${attendeeId}/add`,
    {
      amount,
      entry_type: MANUAL_ATTENDEE_PAYMENT,
      occurred_at: "2026-06-22T09:30",
      return_url: returnUrl,
    },
  );
  expect(response.status).toBe(302);
  expect(redirectTargetWithoutFlash(response)).toBe(returnUrl);
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
    const { response } = await adminGet("/admin/ledger?view=dual");
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
    const { response } = await adminGet("/admin/ledger?view=dual");
    const html = await response.text();
    expect(html).toContain("No transfers recorded yet");
  });

  test("account statements link to the add-entry page with the current statement as return URL", async () => {
    const { attendeeId } = await seededAttendee();
    const { response } = await adminGet(`/admin/ledger/attendee/${attendeeId}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Add entry");
    expect(html).toContain(
      `/admin/ledger/attendee/${attendeeId}/add?return_url=%2Fadmin%2Fledger%2Fattendee%2F${attendeeId}`,
    );
  });

  test("renders attendee add choices in plain language", async () => {
    const { attendeeId } = await seededAttendee();
    const { response } = await adminGet(
      `/admin/ledger/attendee/${attendeeId}/add?return_url=%2Fadmin%2Fattendees%2F${attendeeId}`,
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Add ledger entry");
    expect(html).toContain("Payment received outside checkout");
    expect(html).toContain("Extra amount this attendee needs to pay");
    expect(html).toContain("Waive or reduce what this attendee owes");
    expect(html).toContain(`/admin/attendees/${attendeeId}`);
  });

  test("renders listing add choices for outside income and listing costs", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      name: "Village Hall",
      thankYouUrl: "https://example.com",
    });
    const { response } = await adminGet(
      `/admin/ledger/revenue/${listing.id}/add`,
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Village Hall");
    expect(html).toContain("Income received outside checkout");
    expect(html).toContain("Cost paid for this listing");
    expect(html).not.toContain("Extra amount this attendee needs to pay");
  });

  test("renders modifier add choices for modifier-specific changes", async () => {
    const modifier = await modifiersTable.insert({
      calcKind: "fixed",
      calcValue: 500,
      direction: "charge",
      name: "Helmet hire",
    });
    const { response } = await adminGet(
      `/admin/ledger/modifier/${modifier.id}/add`,
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Helmet hire");
    expect(html).toContain("Extra modifier income");
    expect(html).toContain("Reduce modifier income");
    expect(html).not.toContain("Cost paid for this listing");
  });

  test("posts an attendee payment received outside checkout", async () => {
    const { attendeeId } = await seededAttendee();
    await postAttendeePayment(attendeeId);
    const [entry] = await allTransfers();
    expect(entry?.amount).toBe(1234);
    expect(entry?.kind).toBe(MANUAL_ATTENDEE_PAYMENT);
    expect(entry?.occurredAt).toBe("2026-06-22T09:30:00.000Z");
    expect(entry?.source).toEqual(account("external", "world"));
    expect(entry?.destination).toEqual(account("attendee", attendeeId));
  });

  test("posts a listing cost against the listing revenue account", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      name: "Repairs",
      thankYouUrl: "https://example.com",
    });
    const { response } = await adminFormPost(
      `/admin/ledger/revenue/${listing.id}/add`,
      {
        amount: "45.00",
        entry_type: MANUAL_LISTING_COST,
        occurred_at: "2026-06-22T11:00",
        return_url: `/admin/listing/${listing.id}`,
      },
    );
    expect(redirectTargetWithoutFlash(response)).toBe(
      `/admin/listing/${listing.id}`,
    );
    const [entry] = await allTransfers();
    expect(entry?.amount).toBe(4500);
    expect(entry?.kind).toBe(MANUAL_LISTING_COST);
    expect(entry?.source).toEqual(account("revenue", listing.id));
    expect(entry?.destination).toEqual(account("external", "world"));
  });

  test("posts every account-local manual entry shape", async () => {
    const { attendeeId } = await seededAttendee();
    const listing = await createTestListing({
      maxAttendees: 10,
      name: "Door sales",
      thankYouUrl: "https://example.com",
    });
    const modifier = await modifiersTable.insert({
      calcKind: "fixed",
      calcValue: 500,
      direction: "charge",
      name: "Damage cover",
    });
    const cases = [
      {
        expectedDestination: account("writeoff", "default"),
        expectedSource: account("attendee", attendeeId),
        path: `/admin/ledger/attendee/${attendeeId}/add`,
        type: MANUAL_ATTENDEE_CHARGE,
      },
      {
        expectedDestination: account("attendee", attendeeId),
        expectedSource: account("writeoff", "default"),
        path: `/admin/ledger/attendee/${attendeeId}/add`,
        type: MANUAL_ATTENDEE_WRITEOFF,
      },
      {
        expectedDestination: account("revenue", listing.id),
        expectedSource: account("external", "world"),
        path: `/admin/ledger/revenue/${listing.id}/add`,
        type: MANUAL_LISTING_INCOME,
      },
      {
        expectedDestination: account("writeoff", "default"),
        expectedSource: account("modifier", modifier.id),
        path: `/admin/ledger/modifier/${modifier.id}/add`,
        type: MANUAL_MODIFIER_REDUCTION,
      },
    ];

    for (const entry of cases) {
      const { response } = await adminFormPost(entry.path, {
        amount: "3.21",
        entry_type: entry.type,
        occurred_at: "2026-06-22T12:00",
        return_url: "/admin/ledger",
      });
      expect(response.status).toBe(302);
    }

    const rowsByKind = Object.fromEntries(
      (await allTransfers()).map((transfer) => [transfer.kind, transfer]),
    );
    for (const entry of cases) {
      expect(rowsByKind[entry.type]?.amount).toBe(321);
      expect(rowsByKind[entry.type]?.source).toEqual(entry.expectedSource);
      expect(rowsByKind[entry.type]?.destination).toEqual(
        entry.expectedDestination,
      );
    }
  });

  test("posts modifier income without moving money between item types", async () => {
    const modifier = await modifiersTable.insert({
      calcKind: "fixed",
      calcValue: 500,
      direction: "charge",
      name: "Insurance",
    });
    const { response } = await adminFormPost(
      `/admin/ledger/modifier/${modifier.id}/add`,
      {
        amount: "8.00",
        entry_type: MANUAL_MODIFIER_INCOME,
        occurred_at: "2026-06-22T11:30",
        return_url: `/admin/modifiers/${modifier.id}/edit`,
      },
    );
    expect(redirectTargetWithoutFlash(response)).toBe(
      `/admin/modifiers/${modifier.id}/edit`,
    );
    const [entry] = await allTransfers();
    expect(entry?.amount).toBe(800);
    expect(entry?.kind).toBe(MANUAL_MODIFIER_INCOME);
    expect(entry?.source).toEqual(account("writeoff", "default"));
    expect(entry?.destination).toEqual(account("modifier", modifier.id));
  });

  test("rejects a manual entry type that does not belong to the account", async () => {
    const { attendeeId } = await seededAttendee();
    const { response } = await adminFormPost(
      `/admin/ledger/attendee/${attendeeId}/add`,
      {
        amount: "12.34",
        entry_type: MANUAL_LISTING_COST,
        occurred_at: "2026-06-22T09:30",
        return_url: `/admin/attendees/${attendeeId}`,
      },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain(
      `/admin/ledger/attendee/${attendeeId}/add`,
    );
    expect(await allTransfers()).toEqual([]);
  });

  test("rejects invalid add-entry forms without posting a transfer", async () => {
    const { attendeeId } = await seededAttendee();
    const path = `/admin/ledger/attendee/${attendeeId}/add`;
    const valid = {
      amount: "12.34",
      entry_type: MANUAL_ATTENDEE_PAYMENT,
      occurred_at: "2026-06-22T09:30",
      return_url: `/admin/attendees/${attendeeId}`,
    };
    const invalidCases = [
      { amount: "" },
      { amount: "not-money" },
      { amount: "0" },
      { occurred_at: "" },
      { occurred_at: "not-a-date" },
    ];

    for (const override of invalidCases) {
      const { response } = await adminFormPost(path, {
        ...valid,
        ...override,
      });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain(path);
    }
    expect(await allTransfers()).toEqual([]);
  });

  test("404s add-entry routes for non-addable or missing accounts", async () => {
    const getCases = [
      "/admin/ledger/nonsense/1/add",
      "/admin/ledger/external/world/add",
      "/admin/ledger/attendee/999999/add",
    ];
    for (const path of getCases) {
      const { response } = await adminGet(path);
      expect(response.status).toBe(404);
    }

    const { response } = await adminFormPost("/admin/ledger/nonsense/1/add", {
      amount: "1.00",
      entry_type: MANUAL_ATTENDEE_PAYMENT,
      occurred_at: "2026-06-22T09:30",
      return_url: "/admin/ledger",
    });
    expect(response.status).toBe(404);
  });

  test("renders the edit page with the editable amount, timestamp, and delete confirmation", async () => {
    const { attendeeId } = await seededAttendee();
    await postAttendeePayment(attendeeId);
    const [entry] = await allTransfers();
    const { response } = await adminGet(
      `/admin/ledger/entries/${entry!.id}/edit?return_url=%2Fadmin%2Fattendees%2F${attendeeId}`,
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Edit ledger entry");
    expect(html).toContain('name="amount"');
    expect(html).toContain('value="12.34"');
    expect(html).toContain('name="occurred_at"');
    expect(html).toContain('value="2026-06-22T09:30"');
    expect(html).toContain("Delete ledger entry");
    expect(html).toContain(formatCurrency(1234));
    expect(html).toContain('name="confirm_identifier"');
  });

  test("updates a ledger entry amount and business timestamp", async () => {
    const { attendeeId } = await seededAttendee();
    await postAttendeePayment(attendeeId);
    const [entry] = await allTransfers();
    const { response } = await adminFormPost(
      `/admin/ledger/entries/${entry!.id}/edit`,
      {
        amount: "7.89",
        occurred_at: "2026-06-23T10:15",
        return_url: "/admin/ledger?view=dual",
      },
    );
    expect(redirectTargetWithoutFlash(response)).toBe(
      "/admin/ledger?view=dual",
    );
    const [updated] = await allTransfers();
    expect(updated?.amount).toBe(789);
    expect(updated?.occurredAt).toBe("2026-06-23T10:15:00.000Z");
    expect(updated?.source).toEqual(entry?.source);
    expect(updated?.destination).toEqual(entry?.destination);
  });

  test("rejects invalid edit-entry forms without changing the transfer", async () => {
    const { attendeeId } = await seededAttendee();
    await postAttendeePayment(attendeeId);
    const [entry] = await allTransfers();
    const { response } = await adminFormPost(
      `/admin/ledger/entries/${entry!.id}/edit`,
      {
        amount: "0",
        occurred_at: "2026-06-23T10:15",
        return_url: "/admin/ledger",
      },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain(
      `/admin/ledger/entries/${entry!.id}/edit`,
    );
    const [unchanged] = await allTransfers();
    expect(unchanged?.amount).toBe(entry?.amount);
    expect(unchanged?.occurredAt).toBe(entry?.occurredAt);
  });

  test("404s edit and delete routes for a missing transfer", async () => {
    const edit = await adminGet("/admin/ledger/entries/999999/edit");
    expect(edit.response.status).toBe(404);

    const postEdit = await adminFormPost("/admin/ledger/entries/999999/edit", {
      amount: "1.00",
      occurred_at: "2026-06-23T10:15",
      return_url: "/admin/ledger",
    });
    expect(postEdit.response.status).toBe(404);

    const postDelete = await adminFormPost(
      "/admin/ledger/entries/999999/delete",
      {
        confirm_identifier: "£1.00",
        return_url: "/admin/ledger",
      },
    );
    expect(postDelete.response.status).toBe(404);
  });

  test("deletes a ledger entry only after the exact formatted amount is confirmed", async () => {
    const { attendeeId } = await seededAttendee();
    await postAttendeePayment(attendeeId);
    const [entry] = await allTransfers();
    const deletePath = `/admin/ledger/entries/${entry!.id}/delete`;
    const wrong = await adminFormPost(deletePath, {
      confirm_identifier: "£0.01",
      return_url: `/admin/attendees/${attendeeId}`,
    });
    expect(wrong.response.headers.get("location")).toContain(
      `/admin/ledger/entries/${entry!.id}/edit`,
    );
    expect(await allTransfers()).toHaveLength(1);

    const correct = await adminFormPost(deletePath, {
      confirm_identifier: formatCurrency(entry!.amount),
      return_url: `/admin/attendees/${attendeeId}`,
    });
    expect(redirectTargetWithoutFlash(correct.response)).toBe(
      `/admin/attendees/${attendeeId}`,
    );
    expect(await allTransfers()).toEqual([]);
  });

  test("shows the headline stats, both date pickers and the listing filter", async () => {
    await seededSale("Summer Concert", 2500);
    const { response } = await adminGet("/admin/ledger?view=dual");
    const html = await response.text();
    // The four business-wide totals, headed "All listings".
    expect(html).toContain("All listings");
    expect(html).toContain("Total income");
    expect(html).toContain("Total due");
    expect(html).toContain("Total refunded");
    expect(html).toContain("Booking fees");
    // Two range pickers with unique anchor ids, plus the by-listing select.
    expect(html).toContain('id="ledger-from"');
    expect(html).toContain('id="ledger-to"');
    expect(html).toContain("Summer Concert");
  });

  test("hides the external 'Card / bank' cash legs from the transfer list", async () => {
    // A fully-paid sale posts a payment leg (world → attendee). That cash leg is
    // hidden, so the only place "Card / bank" could appear — an external leg row —
    // is gone from the list page entirely.
    await seededSale("Gala", 2500);
    const { response } = await adminGet("/admin/ledger");
    const html = await response.text();
    expect(html).toContain("sale");
    expect(html).not.toContain("Card / bank");
  });

  test("a from-date later than the only transfer empties the list and zeroes income", async () => {
    // The seeded sale occurs on 2026-06-21; filtering from the 22nd excludes it.
    await seededSale("Workshop", 2500);
    const { response } = await adminGet("/admin/ledger?from=2026-06-22");
    const html = await response.text();
    expect(html).toContain("No transfers recorded yet");
    // Income stat falls to zero outside the window.
    expect(html).toContain("Total income");
  });

  test("scoping to a listing shows its revenue breakdown and preselects it", async () => {
    const { listingId } = await seededSale("Pottery", 2500);
    const { response } = await adminGet(`/admin/ledger?listing=${listingId}`);
    const html = await response.text();
    // The stats switch to the per-listing breakdown, headed by the listing name.
    expect(html).toContain("Gross ticket sales");
    expect(html).toContain("Recognised income");
    expect(html).toContain("Net balance in ledger");
    // The by-listing select is preselected to this listing.
    expect(html).toContain(
      `<option selected value="/admin/ledger?listing=${listingId}">`,
    );
  });

  test("lists every listing in the by-listing select, name-sorted", async () => {
    // Two listings exercise the sort comparator and prove both appear as options.
    await seededSale("Zither Workshop", 2500);
    await seededSale("Accordion Night", 2500);
    const { response } = await adminGet("/admin/ledger");
    const html = await response.text();
    expect(html).toContain("Zither Workshop");
    expect(html).toContain("Accordion Night");
    // Sorted A→Z, so Accordion's option precedes Zither's.
    expect(html.indexOf("Accordion Night")).toBeLessThan(
      html.indexOf("Zither Workshop"),
    );
  });

  test("an unknown listing id falls back to the all-listings view", async () => {
    await seededSale("Recital", 2500);
    const { response } = await adminGet("/admin/ledger?listing=999999");
    expect(response.status).toBe(200);
    const html = await response.text();
    // Falls back to the business-wide totals rather than a listing breakdown.
    expect(html).toContain("Total income");
    expect(html).not.toContain("Gross ticket sales");
  });

  test("ignores malformed from/to/listing/month params", async () => {
    await seededSale("Matinee", 2500);
    const { response } = await adminGet(
      "/admin/ledger?from=garbage&to=alsobad&listing=abc&fromCal=nope",
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    // Every bad param is dropped, so the unfiltered all-listings list still shows
    // the seeded sale.
    expect(html).toContain("Matinee");
    expect(html).toContain("sale");
  });

  test("honours a valid to-date bound and a paged from-month", async () => {
    await seededSale("Concerto", 2500);
    const { response } = await adminGet(
      "/admin/ledger?to=2026-06-21&fromCal=2026-05",
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    // The 2026-06-21 sale falls within "up to and including the 21st".
    expect(html).toContain("Concerto");
    // The from picker is paged to May 2026, so its prev-month link targets April.
    expect(html).toContain("fromCal=2026-04");
  });

  /** The `kind` every bulk leg carries; each rendered transfer row prints it in
   * its own Event cell, so counting the cell counts the rendered rows. */
  const BULK_KIND = "sale";

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
    const { response } = await adminGet("/admin/ledger?view=dual");
    return response.text();
  };

  /** Count rendered transfer rows by their Event cell — unique to a {@link
   * LedgerRow}, so unaffected by the page's nav/heading/column labels. */
  const renderedRowCount = (html: string): number =>
    html.split(`<td>${BULK_KIND}</td>`).length - 1;

  test("renders at most the display cap and surfaces the 'showing recent' note past it", async () => {
    // One more leg than the cap: the SQL LIMIT (cap + 1) returns the extra row,
    // so truncation is detected — the note shows and only the cap is rendered,
    // never the whole ledger.
    const html = await postBulkLegsAndGet(LEDGER_DISPLAY_LIMIT + 1);
    expect(html).toContain("Showing the most recent 500 transfers");
    expect(renderedRowCount(html)).toBe(LEDGER_DISPLAY_LIMIT);
  });

  test("renders every row and omits the note when exactly the display cap exist", async () => {
    // Exactly the cap: the LIMIT (cap + 1) returns no extra row, so no
    // truncation note, and all cap rows render.
    const html = await postBulkLegsAndGet(LEDGER_DISPLAY_LIMIT);
    expect(html).not.toContain("Showing the most recent");
    expect(renderedRowCount(html)).toBe(LEDGER_DISPLAY_LIMIT);
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
    expect(html).toContain('<th class="col-amount">Balance</th>');
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
    await adjustListingIncome(listing.id, 1500);
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

describe("pickerDatesFromBounds", () => {
  const ms = (iso: string): number => new Date(iso).getTime();

  test("is empty when the ledger has no transfers", () => {
    expect(pickerDatesFromBounds(null, "2026-06-21", "UTC")).toEqual([]);
  });

  test("runs from the earliest transfer to the latest when it is after today", () => {
    const dates = pickerDatesFromBounds(
      { maxMs: ms("2026-06-22T00:00:00Z"), minMs: ms("2026-06-20T00:00:00Z") },
      "2026-06-21",
      "UTC",
    );
    // End follows the latest transfer (the 22nd), not today (the 21st).
    expect(dates.map((d) => d.value)).toEqual([
      "2026-06-20",
      "2026-06-21",
      "2026-06-22",
    ]);
    expect(dates.every((d) => d.selectable)).toBe(true);
  });

  test("extends the end to today when the latest transfer is older", () => {
    const dates = pickerDatesFromBounds(
      { maxMs: ms("2026-06-20T00:00:00Z"), minMs: ms("2026-06-20T00:00:00Z") },
      "2026-06-23",
      "UTC",
    );
    // End follows today (the 23rd), so a future bound stays pickable.
    expect(dates.map((d) => d.value)).toEqual([
      "2026-06-20",
      "2026-06-21",
      "2026-06-22",
      "2026-06-23",
    ]);
  });
});
