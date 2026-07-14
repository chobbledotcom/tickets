import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
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
import { modifiersTable } from "#shared/db/modifiers.ts";
import { account } from "#shared/ledger/account.ts";
import { expectFlash, expectFlashRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";
import { withSetting } from "#test-utils/settings.ts";
import {
  postAttendeePayment,
  redirectTargetWithoutFlash,
  seededAttendee,
  seededSale,
} from "./helpers.ts";

describeWithEnv("server (admin ledger add entry)", { db: true }, () => {
  test("account statements link to the add-entry page with the current statement as return URL", async () => {
    const { attendeeId } = await seededAttendee();
    const response = await adminGet(`/admin/ledger/attendee/${attendeeId}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Add money change");
    expect(html).toContain(
      `/admin/ledger/attendee/${attendeeId}/add?return_url=%2Fadmin%2Fledger%2Fattendee%2F${attendeeId}`,
    );
  });

  test("renders attendee add choices in plain language", async () => {
    const { attendeeId } = await seededAttendee();
    const response = await adminGet(
      `/admin/ledger/attendee/${attendeeId}/add?return_url=%2Fadmin%2Fattendees%2F${attendeeId}`,
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Add money change");
    expect(html).toContain("Payment received another way");
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
    const response = await adminGet(`/admin/ledger/revenue/${listing.id}/add`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Village Hall");
    expect(html).toContain("Income received another way");
    expect(html).toContain("Listing cost paid another way");
    expect(html).not.toContain("Extra amount this attendee needs to pay");
  });

  test("renders modifier add choices for modifier-specific changes", async () => {
    const modifier = await modifiersTable.insert({
      calcKind: "fixed",
      calcValue: 500,
      direction: "charge",
      name: "Helmet hire",
    });
    const response = await adminGet(
      `/admin/ledger/modifier/${modifier.id}/add`,
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Helmet hire");
    expect(html).toContain("Extra option income");
    expect(html).toContain("Reduce option income");
    expect(html).not.toContain("Listing cost paid another way");
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

  test("refuses a manual attendee entry while a checkout is pending", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      unitPrice: 1000,
    });
    const { stageMidPaymentAttendee } = await import(
      "../server-attendees/helpers.ts"
    );
    const stage = await stageMidPaymentAttendee(listing, "cs_ledger_add");
    // The checkout's activation posts its own sale/payment legs when the
    // payment lands; a manual entry added mid-payment would combine with
    // them into a surprise balance, so the write is refused.
    const { response } = await adminFormPost(
      `/admin/ledger/attendee/${stage.attendeeId}/add`,
      {
        amount: "12.34",
        entry_type: MANUAL_ATTENDEE_PAYMENT,
        occurred_at: "2026-06-22T09:30",
      },
    );
    expect(response.status).toBe(302);
    expectFlash(response, expect.stringContaining("mid-payment"), false);
    expect(await allTransfers()).toEqual([]);
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
      { amount: "12abc" },
      { amount: "1,000" },
      { amount: "1e2" },
      { amount: "12.345" },
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

  test("validates add-entry amounts with the configured currency precision", async () => {
    const { attendeeId } = await seededAttendee();
    const path = `/admin/ledger/attendee/${attendeeId}/add`;
    const valid = {
      amount: "1234",
      entry_type: MANUAL_ATTENDEE_PAYMENT,
      occurred_at: "2026-06-22T09:30",
      return_url: "/admin/ledger",
    };

    await withSetting({ currency: "JPY" }, async () => {
      const decimal = await adminFormPost(path, {
        ...valid,
        amount: "12.34",
      });
      expect(decimal.response.status).toBe(302);
      expect(decimal.response.headers.get("location")).toContain(path);
      expect(await allTransfers()).toEqual([]);

      const whole = await adminFormPost(path, valid);
      await expectFlashRedirect(
        "/admin/ledger",
        "Money change added.",
      )(whole.response);
    });

    const [entry] = await allTransfers();
    expect(entry?.amount).toBe(1234);
    expect(entry?.kind).toBe(MANUAL_ATTENDEE_PAYMENT);
  });

  test("404s add-entry routes for non-addable or missing accounts", async () => {
    const getCases = [
      "/admin/ledger/nonsense/1/add",
      "/admin/ledger/external/world/add",
      "/admin/ledger/attendee/999999/add",
    ];
    for (const path of getCases) {
      const response = await adminGet(path);
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

  test("404s the add-entry route for a cost account (no owner-enterable types)", async () => {
    // A cost account has a statement page but the manual-entry spec table
    // offers it nothing, so the add form must 404 rather than render empty.
    const { listingId } = await seededSale("Workshop", 4000);
    const response = await adminGet(`/admin/ledger/cost/${listingId}/add`);
    expect(response.status).toBe(404);
  });
});
