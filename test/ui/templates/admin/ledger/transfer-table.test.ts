import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { KIND } from "#shared/accounting/kinds.ts";
import {
  MANUAL_ATTENDEE_PAYMENT,
  ManualLedgerEntryTypeSchema,
} from "#shared/accounting/manual-entries.ts";
import { formatCurrency } from "#shared/currency.ts";
import { names, renderLedger, transfer } from "./helpers.ts";

describe("LedgerTable", () => {
  test("renders each money change with a translated event, time and amount", () => {
    const refs = names({
      attendees: new Map([[1, "Ada"]]),
      listings: new Map([[1, "Concert"]]),
    });
    const html = renderLedger(
      [transfer({ amount: 2500, kind: "sale" })],
      refs,
      "dual",
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
    const html = renderLedger([transfer({})], names(), "dual");
    expect(html).toContain("<td>No event type</td>");
  });

  test("treats a synthetic empty event type as absent", () => {
    // The store maps a kindless stored row back to an omitted kind, so "" only
    // arises synthetically — it must still read as "no kind", never a blank cell.
    const html = renderLedger([transfer({ kind: "" })], names(), "dual");
    expect(html).toContain("<td>No event type</td>");
    expect(html).not.toContain("<td></td>");
  });

  test("uses a safe translated label for an unknown opaque event type", () => {
    const html = renderLedger(
      [transfer({ kind: "future_money_change" })],
      names(),
      "dual",
    );
    expect(html).toContain("<td>Other money change</td>");
    expect(html).not.toContain("future_money_change");
  });

  test("has a translated detailed-view label for every known event type", () => {
    const kinds = [
      ...Object.values(KIND),
      ...ManualLedgerEntryTypeSchema.options,
    ];
    const html = renderLedger(
      kinds.map((kind, index) => transfer({ id: index + 1, kind })),
      names(),
      "dual",
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
    const html = renderLedger([], names(), "dual");
    expect(html).toContain('colspan="4"');
    expect(html).toContain("No money changes yet.");
  });

  test("escapes a stored name so PII cannot inject markup", () => {
    const refs = names({ attendees: new Map([[1, "<script>x</script>"]]) });
    const html = renderLedger([transfer()], refs, "dual");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain("<script>x</script>");
  });

  test("links manual-entry amounts to the edit page when a return URL is supplied", () => {
    const html = renderLedger(
      [transfer({ id: 77, kind: MANUAL_ATTENDEE_PAYMENT })],
      names(),
      "dual",
      "/admin/ledger?listing=1",
    );
    expect(html).toContain(
      'href="/admin/ledger/entries/77/edit?return_url=%2Fadmin%2Fledger%3Flisting%3D1"',
    );
    expect(html).toContain(formatCurrency(5000));
  });

  test("does not link manual-entry amounts without a return URL", () => {
    const html = renderLedger(
      [transfer({ id: 77, kind: "sale" })],
      names(),
      "dual",
    );
    expect(html).not.toContain("/admin/ledger/entries/77/edit");
    expect(html).toContain(`>${formatCurrency(5000)}<`);
  });
});
