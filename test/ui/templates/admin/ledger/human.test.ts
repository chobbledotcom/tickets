import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { account } from "#shared/ledger/account.ts";
import { HumanLedgerTable } from "#templates/admin/ledger.tsx";

import { names, transfer } from "./helpers.ts";

describe("HumanLedgerTable", () => {
  test("renders plain-language descriptions for every known ledger event family", () => {
    const refs = names({
      attendees: new Map([[1, "Ada"]]),
      listings: new Map([[1, "Concert"]]),
      modifiers: new Map([[1, "Helmet hire"]]),
    });
    const html = String(
      HumanLedgerTable({
        names: refs,
        transfers: [
          transfer({
            destination: account("attendee", 1),
            id: 1,
            kind: "payment",
            source: account("external", "world"),
          }),
          transfer({
            destination: account("revenue", 1),
            id: 2,
            kind: "payment",
            source: account("external", "world"),
          }),
          transfer({
            destination: account("external", "world"),
            id: 3,
            kind: "refund_cash",
            source: account("attendee", 1),
          }),
          transfer({
            destination: account("attendee", 1),
            id: 4,
            kind: "refund_sale",
            source: account("revenue", 1),
          }),
          transfer({
            destination: account("fee_income", "booking"),
            id: 5,
            kind: "fee",
            source: account("attendee", 1),
          }),
          transfer({
            destination: account("attendee", 1),
            id: 6,
            kind: "refund_fee",
            source: account("fee_income", "booking"),
          }),
          transfer({
            destination: account("revenue", 1),
            id: 7,
            kind: "adjustment",
            source: account("writeoff", "default"),
          }),
          transfer({
            destination: account("writeoff", "default"),
            id: 8,
            kind: "adjustment",
            source: account("revenue", 1),
          }),
          transfer({
            destination: account("revenue", 1),
            id: 9,
            kind: "adjustment",
            source: account("attendee", 1),
          }),
          transfer({
            destination: account("attendee", 1),
            id: 10,
            kind: "manual_attendee_payment",
            source: account("external", "world"),
          }),
          transfer({
            destination: account("writeoff", "default"),
            id: 11,
            kind: "manual_attendee_charge",
            source: account("attendee", 1),
          }),
          transfer({
            destination: account("attendee", 1),
            id: 12,
            kind: "manual_attendee_writeoff",
            source: account("writeoff", "default"),
          }),
          transfer({
            destination: account("revenue", 1),
            id: 13,
            kind: "manual_listing_income",
            source: account("external", "world"),
          }),
          transfer({
            destination: account("external", "world"),
            id: 14,
            kind: "manual_listing_cost",
            source: account("revenue", 1),
          }),
          transfer({
            destination: account("modifier", 1),
            id: 15,
            kind: "manual_modifier_income",
            source: account("writeoff", "default"),
          }),
          transfer({
            destination: account("writeoff", "default"),
            id: 16,
            kind: "manual_modifier_reduction",
            source: account("modifier", 1),
          }),
          transfer({
            destination: account("external", "world"),
            id: 17,
            kind: "service_cost",
            source: account("cost", 1),
          }),
          transfer({
            destination: account("cost", 1),
            id: 18,
            kind: "service_cost",
            source: account("external", "world"),
          }),
          transfer({
            destination: account("revenue", 1),
            id: 19,
            kind: "future_kind",
            source: account("attendee", 1),
          }),
        ],
      }),
    );

    for (const phrase of [
      "Payment received for",
      "Refund paid to",
      "Refund removed income from",
      "Booking fee recorded",
      "Booking fee refunded",
      "Manual correction increased",
      "Manual correction reduced",
      "Transfer from",
      "Payment received outside checkout for",
      "Extra amount now owed by",
      "Amount waived from the balance for",
      "Income received outside checkout for",
      "Cost paid outside checkout for",
      "Modifier income added for",
      "Modifier income reduced for",
      "Service cost recorded for",
      "Service cost reduced for",
    ]) {
      expect(html).toContain(phrase);
    }
    expect(html).toContain("Ada");
    expect(html).toContain("Concert");
    expect(html).toContain("Helmet hire");
    expect(html).toContain(
      'Payment received for <a href="/admin/ledger/attendee/1">Ada</a>',
    );
    expect(html).toContain(
      'Manual correction reduced <a href="/admin/ledger?listing=1">Concert</a>',
    );
    const rows = html.split("<tr>");
    expect(rows[2]).toContain("+£50");
    expect(rows[4]).toContain("−£50");
    expect(rows[18]).toContain("−£50");
    expect(rows[19]).toContain("+£50");
  });

  test("uses attendee-balance wording for adjustment legs against writeoff", () => {
    const refs = names({ attendees: new Map([[1, "Ada"]]) });
    const html = String(
      HumanLedgerTable({
        names: refs,
        transfers: [
          transfer({
            destination: account("writeoff", "default"),
            id: 1,
            kind: "adjustment",
            source: account("attendee", 1),
          }),
          transfer({
            destination: account("attendee", 1),
            id: 2,
            kind: "adjustment",
            source: account("writeoff", "default"),
          }),
        ],
      }),
    );
    expect(html).toContain("Extra amount now owed by");
    expect(html).toContain("Amount waived from the balance for");
    expect(html).toContain("Ada");
    expect(html).not.toContain("Manual correction reduced");
    expect(html).not.toContain("Manual correction increased");
    const rows = html.split("<tr>");
    expect(rows[2]).toContain("+£50");
    expect(rows[3]).toContain("−£50");
  });

  test("shows modifier income as positive and discounts as negative", () => {
    const modifier = account("modifier", 1);
    const html = String(
      HumanLedgerTable({
        names: names({ modifiers: new Map([[1, "Helmet hire"]]) }),
        transfers: [
          transfer({
            destination: modifier,
            id: 1,
            kind: "modifier",
            source: account("attendee", 1),
          }),
          transfer({
            destination: account("attendee", 1),
            id: 2,
            kind: "modifier",
            source: modifier,
          }),
        ],
      }),
    );
    const rows = html.split("<tr>");
    expect(rows[2]).toContain("+£50");
    expect(rows[3]).toContain("−£50");
  });
});
