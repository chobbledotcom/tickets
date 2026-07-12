import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { KIND } from "#shared/accounting/kinds.ts";
import {
  MANUAL_ATTENDEE_CHARGE,
  MANUAL_ATTENDEE_PAYMENT,
  MANUAL_ATTENDEE_WRITEOFF,
  MANUAL_LISTING_COST,
  MANUAL_LISTING_INCOME,
  MANUAL_MODIFIER_INCOME,
  MANUAL_MODIFIER_REDUCTION,
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
    const cases = [
      [KIND.adjustment, "Correction"],
      [KIND.fee, "Booking fee"],
      [KIND.modifier, "Price change"],
      [KIND.payment, "Payment received"],
      [KIND.refundCash, "Refund paid"],
      [KIND.refundFee, "Booking fee refunded"],
      [KIND.refundModifier, "Price change refunded"],
      [KIND.refundSale, "Booking refunded"],
      [KIND.reversal, "Change reversed"],
      [KIND.sale, "Booking made"],
      [KIND.serviceCost, "Service event cost"],
      [MANUAL_ATTENDEE_PAYMENT, "Payment received another way"],
      [MANUAL_ATTENDEE_CHARGE, "Extra amount owed"],
      [MANUAL_ATTENDEE_WRITEOFF, "Amount no longer owed"],
      [MANUAL_LISTING_INCOME, "Income received another way"],
      [MANUAL_LISTING_COST, "Listing cost paid another way"],
      [MANUAL_MODIFIER_INCOME, "Extra option income"],
      [MANUAL_MODIFIER_REDUCTION, "Option income reduced"],
    ] as const;
    expect(cases.map(([kind]) => kind)).toEqual([
      ...Object.values(KIND),
      ...ManualLedgerEntryTypeSchema.options,
    ]);
    for (const [kind, label] of cases) {
      const html = renderLedger([transfer({ kind })], names(), "dual");
      expect(html).not.toContain(`>${kind}<`);
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
      [transfer({ id: 77, kind: MANUAL_ATTENDEE_PAYMENT })],
      names(),
      "dual",
      "",
    );
    expect(html).not.toContain("/admin/ledger/entries/77/edit");
    expect(html).toContain(`>${formatCurrency(5000)}<`);
  });
});
