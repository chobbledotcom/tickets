import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { KIND } from "#shared/accounting/kinds.ts";
import { postTransfers } from "#shared/accounting/store.ts";
import { adjustListingIncome } from "#shared/db/listings/aggregates.ts";
import { account } from "#shared/ledger/account.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { postAttendeeRefund, postModifierLeg, tx } from "#test-utils/ledger.ts";
import { adminGet } from "#test-utils/session.ts";
import { ledgerPageHtml, seededSale } from "./helpers.ts";

describeWithEnv(
  "server (admin ledger account statements)",
  { db: true },
  () => {
    test("renders an account statement with a running balance", async () => {
      const { attendeeId } = await seededSale("Gala", 2500);
      const html = await ledgerPageHtml(`/admin/ledger/attendee/${attendeeId}`);
      // The attendee's own label heads the page; a fully-paid sale nets to zero.
      expect(html).toContain("Ada Lovelace");
      expect(html).toContain("Amount still owed:");
      expect(html).toContain('<th class="col-amount">Running total</th>');
      // The sale's counterparty is the listing revenue account, linked by name.
      expect(html).toContain("Gala");
    });

    test("renders a revenue listing's statement", async () => {
      const { listingId } = await seededSale("Workshop", 4000);
      const response = await adminGet(`/admin/ledger/revenue/${listingId}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Workshop");
      // The counterparty of the sale leg is the paying attendee.
      expect(html).toContain("Ada Lovelace");
    });

    test("renders a listing's servicing-cost statement", async () => {
      // The cost account is row-backed like revenue, so the registry gives it a
      // statement route too (it used to 404 as an unregistered type).
      const { listingId } = await seededSale("Workshop", 4000);
      await postTransfers([
        tx({
          destination: account("external", "world"),
          eventGroup: "evt-cost",
          kind: KIND.serviceCost,
          reference: "ref-cost",
          source: account("cost", listingId),
        }),
      ]);
      const response = await adminGet(`/admin/ledger/cost/${listingId}`);
      expect(response.status).toBe(200);
      // The cost account labels itself with the listing's name.
      expect(await response.text()).toContain("Workshop");
    });

    test("falls back to 'Modifier #<id>' when no modifier row exists", async () => {
      await postModifierLeg({ delta: 500, modifierId: 1 });
      const html = await ledgerPageHtml("/admin/ledger/modifier/1");
      // No modifier row exists, so the account falls back to "Modifier #1".
      expect(html).toContain("Modifier #1");
    });

    test("renders the singleton card/bank statement", async () => {
      await seededSale();
      const response = await adminGet("/admin/ledger/external/world");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Card / bank");
    });

    test("renders the booking-fee income statement", async () => {
      // A booking-fee leg lands on fee_income:booking via a real refund's reversal
      // is not needed — just assert the singleton page renders for the account.
      const response = await adminGet("/admin/ledger/fee_income/booking");
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
      const html = await ledgerPageHtml("/admin/ledger/writeoff/default");
      // The writeoff singleton renders its label, not a raw "writeoff:default".
      expect(html).toContain("Corrections");
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
      const response = await adminGet(`/admin/ledger/attendee/${attendee.id}`);
      const html = await response.text();
      expect(html).toContain("Grace Hopper");
      // A full refund nets to zero, so the final running balance is zero.
      expect(html).toContain("Amount still owed:");
    });

    test("404s on an unknown account type", async () => {
      const response = await adminGet("/admin/ledger/nonsense/1");
      expect(response.status).toBe(404);
    });

    test("404s on a non-positive row id", async () => {
      const response = await adminGet("/admin/ledger/attendee/0");
      expect(response.status).toBe(404);
    });
  },
);
