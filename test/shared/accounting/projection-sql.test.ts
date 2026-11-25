import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  ATTENDEE,
  REVENUE,
  WORLD,
  WRITEOFF_TYPE,
} from "#accounting/accounts.ts";
import { KIND } from "#accounting/kinds.ts";
import { MANUAL_ATTENDEE_CHARGE } from "#accounting/manual-entries.ts";
import {
  accountBalanceSubquery,
  attendeeOwedSubquery,
  bookingSaleTotalSubquery,
  externalCashBalanceSubquery,
  type Leg,
  ledgerLegs,
  modifierLeg,
  onAccount,
  orderTotalSubquery,
  paymentLegExists,
  reservationSubtotalSubquery,
  saleLeg,
  signedSum,
} from "#accounting/projection-sql.ts";
import { tableNode } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";
import { sql } from "#db/sql.ts";

// Constants are imported (never hardcoded) so a rename of the kind/account
// vocabulary updates the expected SQL here too. The SQL *structure* — column
// names, the `CAST(… AS TEXT)`, the CASE/COALESCE shape — is spelled out
// independently below, so a regression in a builder shows as a mismatch.

const leg: Leg = tableNode(tables.transfers, "leg");
const la = tableNode(tables.listing_attendees, "la");
const a = tableNode(tables.attendees, "a");
const listing = tableNode(tables.listings, "listing");

/** The account test of one side, as the projections write it. */
const side = (role: string, type: string, id: string): string =>
  `leg.${role}_type = '${type}' AND leg.${role}_id = CAST(${id} AS TEXT)`;

/** The signed sum of the ledger amounts, as the projections write it. */
const signed = (adds: string, subtracts: string): string =>
  `COALESCE(SUM((CASE WHEN ${adds} THEN leg.amount ELSE 0 END - CASE WHEN ${subtracts} THEN leg.amount ELSE 0 END)), 0)`;

/** A figure of its own over the rows that add or subtract. */
const figure = (adds: string, subtracts: string, scope = ""): string =>
  `(SELECT ${signed(adds, subtracts)} FROM transfers AS leg WHERE ${scope}((${adds}) OR (${subtracts})))`;

describe("ledgerLegs", () => {
  test("reads the ledger under the word leg", () => {
    expect(ledgerLegs().select((row) => ({ id: row.id })).sql).toBe(
      "SELECT leg.id AS id FROM transfers AS leg",
    );
  });
});

describe("onAccount", () => {
  const sides = [
    ["source", ATTENDEE, la.attendeeId, "la.attendee_id"],
    ["dest", REVENUE, listing.id, "listing.id"],
    ["dest", WRITEOFF_TYPE, a.id, "a.id"],
  ] as const;

  for (const [role, type, id, idText] of sides) {
    test(`matches the ${role} side of a ${type} account with the id CAST to TEXT`, () => {
      expect(onAccount(role, type, id)(leg).sql).toBe(side(role, type, idText));
    });
  }

  test("binds an id that is text", () => {
    expect(onAccount("dest", ATTENDEE, "7")(leg)).toEqual(
      sql`leg.dest_type = 'attendee' AND leg.dest_id = CAST(${"7"} AS TEXT)`,
    );
  });
});

const saleLegText =
  `leg.kind = '${KIND.sale}'` +
  ` AND ${side("source", ATTENDEE, "la.attendee_id")}` +
  ` AND ${side("dest", REVENUE, "la.listing_id")}` +
  " AND leg.event_group = la.ledger_event_group";

describe("saleLeg", () => {
  test("scopes a gross sale leg: kind + attendee source + revenue dest + event group", () => {
    expect(
      saleLeg(la.attendeeId, la.listingId, la.ledgerEventGroup)(leg).sql,
    ).toBe(saleLegText);
  });
});

describe("paymentLegExists", () => {
  test("asks for a payment leg into the attendee in the event group", () => {
    expect(paymentLegExists(la.attendeeId, la.ledgerEventGroup).sql).toBe(
      `EXISTS (SELECT 1 FROM transfers AS leg WHERE leg.kind = '${KIND.payment}'` +
        ` AND ${side("dest", ATTENDEE, "la.attendee_id")}` +
        " AND leg.event_group = la.ledger_event_group)",
    );
  });
});

describe("signedSum", () => {
  test("adds the rows of the first test, subtracts the rows of the second, zero otherwise", () => {
    expect(
      signedSum(
        onAccount("dest", ATTENDEE, a.id),
        onAccount("source", ATTENDEE, a.id),
      )(leg).sql,
    ).toBe(
      signed(side("dest", ATTENDEE, "a.id"), side("source", ATTENDEE, "a.id")),
    );
  });

  test("keeps the values the tests bind", () => {
    expect(
      signedSum(
        onAccount("dest", ATTENDEE, "a"),
        onAccount("source", ATTENDEE, "b"),
      )(leg).args,
    ).toEqual(["a", "b"]);
  });
});

describe("bookingSaleTotalSubquery", () => {
  test("sums the sale leg and the tax corrections of the booking", () => {
    const credit = `${side("source", ATTENDEE, "la.attendee_id")} AND ${side("dest", REVENUE, "la.listing_id")}`;
    const debit = `${side("dest", ATTENDEE, "la.attendee_id")} AND ${side("source", REVENUE, "la.listing_id")}`;
    const corrected =
      "SELECT assessment.event_group FROM booking_tax_assessments AS assessment WHERE assessment.booking_group = la.ledger_event_group";
    expect(
      bookingSaleTotalSubquery(la.attendeeId, la.listingId, la.ledgerEventGroup)
        .sql,
    ).toBe(
      `(SELECT ${signed(credit, debit)} FROM transfers AS leg WHERE ((${saleLegText})` +
        ` OR (leg.kind = '${KIND.taxSale}' AND leg.event_group IN (${corrected})` +
        ` AND ((${credit}) OR (${debit})))))`,
    );
  });
});

const attendeeIn = side("dest", ATTENDEE, "a.id");
const attendeeOut = side("source", ATTENDEE, "a.id");

describe("accountBalanceSubquery", () => {
  test("is a bare signed-sum subquery over the account's own legs", () => {
    expect(accountBalanceSubquery(ATTENDEE, a.id).sql).toBe(
      figure(attendeeIn, attendeeOut),
    );
  });
});

describe("externalCashBalanceSubquery", () => {
  test("adds cash received and subtracts cash returned", () => {
    const world = (role: string): string =>
      `leg.${role}_type = '${WORLD.type}' AND leg.${role}_id = '${WORLD.id}'`;
    expect(externalCashBalanceSubquery(ATTENDEE, a.id).sql).toBe(
      figure(
        `${attendeeIn} AND ${world("source")}`,
        `${attendeeOut} AND ${world("dest")}`,
      ),
    );
  });
});

describe("order amount subqueries", () => {
  const expectedTotal = (kinds: readonly string[]): string =>
    figure(
      attendeeOut,
      attendeeIn,
      `leg.kind IN (${kinds.map((kind) => `'${kind}'`).join(", ")}) AND `,
    );

  const reservationKinds = [
    KIND.sale,
    KIND.modifier,
    KIND.taxSale,
    KIND.taxModifier,
    KIND.vat,
  ];

  test("keeps fees and manual charges out of the reservation subtotal", () => {
    expect(reservationSubtotalSubquery(ATTENDEE, a.id).sql).toBe(
      expectedTotal(reservationKinds),
    );
  });

  test("includes fees, VAT and manual charges in the full order total", () => {
    expect(orderTotalSubquery(ATTENDEE, a.id).sql).toBe(
      expectedTotal([...reservationKinds, KIND.fee, MANUAL_ATTENDEE_CHARGE]),
    );
  });
});

describe("attendeeOwedSubquery", () => {
  test("is the negation of the attendee's balance subquery", () => {
    expect(attendeeOwedSubquery(a.id).sql).toBe(
      `-${accountBalanceSubquery(ATTENDEE, a.id).sql}`,
    );
  });

  test("scopes to the attendee account type, not revenue", () => {
    const { sql: text } = attendeeOwedSubquery(a.id);
    expect(text.startsWith("-(SELECT")).toBe(true);
    assertStringIncludes(text, `leg.dest_type = '${ATTENDEE}'`);
    assert(!text.includes(`'${REVENUE}'`));
  });
});

describe("modifierLeg", () => {
  test("reads the modifier from the side that holds it", () => {
    expect(modifierLeg.accountId(leg).sql).toBe(
      "CASE WHEN leg.dest_type = 'modifier' THEN leg.dest_id ELSE leg.source_id END",
    );
  });

  test("adds a surcharge and subtracts a discount", () => {
    expect(modifierLeg.signedAmount(leg).sql).toBe(
      signed("leg.dest_type = 'modifier'", "leg.source_type = 'modifier'"),
    );
  });

  test("keeps the modifier legs only", () => {
    expect(modifierLeg.filter(leg).sql).toBe(`leg.kind = '${KIND.modifier}'`);
  });
});
