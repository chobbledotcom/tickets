import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { KIND } from "#shared/accounting/kinds.ts";
import {
  MANUAL_ATTENDEE_PAYMENT,
  ManualLedgerEntryTypeSchema,
} from "#shared/accounting/manual-entries.ts";
import { formatCurrency } from "#shared/currency.ts";
import { LedgerTable } from "#templates/admin/ledger.tsx";

import { names, transfer } from "./helpers.ts";

describe("LedgerTable", () => {
  test("renders each money change with a translated event, time and amount", () => {
    const refs = names({
      attendees: new Map([[1, "Ada"]]),
      listings: new Map([[1, "Concert"]]),
    });
    const html = String(
      LedgerTable({
        names: refs,
        transfers: [transfer({ amount: 2500, kind: "sale" })],
      }),
    );
    expect(html).toContain("table-scroll");
    expect(html).toContain("<th>Time</th>");
    expect(html).toContain("Booking made");
    expect(html).not.toContain(">sale<");
    // Both legs resolve to links, joined by an arrow (rendered as the glyph).
    expect(html).toContain('<a href="/admin/ledger/attendee/1">Ada</a>');
    expect(html).toContain('<a href="/admin/ledger?listing=1">Concert</a>');
    expect(html).toContain("→");
    expect(html).toContain(formatCurrency(2500));
  });

  test("explains a money change with no event type", () => {
    const html = String(
      LedgerTable({
        names: names(),
        transfers: [transfer({})],
      }),
    );
    expect(html).toContain("<td>No event type</td>");
  });

  test("treats a synthetic empty event type as absent", () => {
    // The store maps a kindless stored row back to an omitted kind, so "" only
    // arises synthetically — it must still read as "no kind", never a blank cell.
    const html = String(
      LedgerTable({
        names: names(),
        transfers: [transfer({ kind: "" })],
      }),
    );
    expect(html).toContain("<td>No event type</td>");
    expect(html).not.toContain("<td></td>");
  });

  test("uses a safe translated label for an unknown opaque event type", () => {
    const html = String(
      LedgerTable({
        names: names(),
        transfers: [transfer({ kind: "future_money_change" })],
      }),
    );
    expect(html).toContain("<td>Other money change</td>");
    expect(html).not.toContain("future_money_change");
  });

  test("has a translated detailed-view label for every known event type", () => {
    const kinds = [
      ...Object.values(KIND),
      ...ManualLedgerEntryTypeSchema.options,
    ];
    const html = String(
      LedgerTable({
        names: names(),
        transfers: kinds.map((kind, index) =>
          transfer({ id: index + 1, kind }),
        ),
      }),
    );
    for (const kind of kinds) {
      expect(html).not.toContain(`>${kind}<`);
    }
    for (const label of [
      "Correction",
      "Booking fee",
      "Price change",
      "Payment received",
      "Refund paid",
      "Booking fee refunded",
      "Price change refunded",
      "Booking refunded",
      "Change reversed",
      "Booking made",
      "Service event cost",
      "Payment received another way",
      "Extra amount owed",
      "Amount no longer owed",
      "Income received another way",
      "Listing cost paid another way",
      "Extra option income",
      "Option income reduced",
    ]) {
      expect(html).toContain(`>${label}<`);
    }
  });

  test("renders the empty state row spanning all four columns", () => {
    const html = String(LedgerTable({ names: names(), transfers: [] }));
    expect(html).toContain('colspan="4"');
    expect(html).toContain("No money changes yet.");
  });

  test("escapes a stored name so PII cannot inject markup", () => {
    const refs = names({ attendees: new Map([[1, "<script>x</script>"]]) });
    const html = String(LedgerTable({ names: refs, transfers: [transfer()] }));
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain("<script>x</script>");
  });

  test("links manual-entry amounts to the edit page when a return URL is supplied", () => {
    const html = String(
      LedgerTable({
        names: names(),
        returnUrl: "/admin/ledger?listing=1",
        transfers: [transfer({ id: 77, kind: MANUAL_ATTENDEE_PAYMENT })],
      }),
    );
    expect(html).toContain(
      'href="/admin/ledger/entries/77/edit?return_url=%2Fadmin%2Fledger%3Flisting%3D1"',
    );
    expect(html).toContain(formatCurrency(5000));
  });

  test("does not link manual-entry amounts without a return URL", () => {
    const html = String(
      LedgerTable({
        names: names(),
        transfers: [transfer({ id: 77, kind: MANUAL_ATTENDEE_PAYMENT })],
      }),
    );
    expect(html).not.toContain("/admin/ledger/entries/77/edit");
    expect(html).toContain(`>${formatCurrency(5000)}<`);
  });

  test("does not link checkout-event amounts to the maintenance edit route", () => {
    const html = String(
      LedgerTable({
        names: names(),
        returnUrl: "/admin/ledger?listing=1",
        transfers: [transfer({ id: 77, kind: "sale" })],
      }),
    );
    expect(html).not.toContain("/admin/ledger/entries/77/edit");
    expect(html).toContain(`>${formatCurrency(5000)}<`);
  });
});
