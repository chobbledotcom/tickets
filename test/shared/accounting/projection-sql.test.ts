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
  accountPredicate,
  attendeeOwedSubquery,
  creditsLessWriteoffDebits,
  externalCashBalanceSubquery,
  LEG_COLUMNS,
  orderTotalSubquery,
  reservationSubtotalSubquery,
  saleLegPredicate,
  signedSumCase,
} from "#accounting/projection-sql.ts";
import { sql, sqlCommas, sqlLiteral } from "#db/sql.ts";

// Constants are imported (never hardcoded) so a rename of the kind/account
// vocabulary updates the expected SQL here too. The SQL *structure* — column
// names, the `CAST(… AS TEXT)`, the CASE/COALESCE shape — is spelled out
// independently below, so a regression in a builder shows as a mismatch.

describe("LEG_COLUMNS", () => {
  test("names the source and dest type/id columns", () => {
    expect(LEG_COLUMNS).toEqual({
      dest: { id: "dest_id", type: "dest_type" },
      source: { id: "source_id", type: "source_type" },
    });
  });
});

describe("accountPredicate", () => {
  test("matches the source leg with a TEXT-cast id expression", () => {
    expect(accountPredicate("source", ATTENDEE, sql`la.attendee_id`).sql).toBe(
      `source_type = '${ATTENDEE}' AND source_id = CAST(la.attendee_id AS TEXT)`,
    );
  });

  test("matches the dest leg using the dest_* columns", () => {
    expect(accountPredicate("dest", REVENUE, sql`listing.id`).sql).toBe(
      `dest_type = '${REVENUE}' AND dest_id = CAST(listing.id AS TEXT)`,
    );
  });

  test("interpolates the account type verbatim", () => {
    expect(accountPredicate("dest", WRITEOFF_TYPE, sql`0`).sql).toBe(
      `dest_type = '${WRITEOFF_TYPE}' AND dest_id = CAST(0 AS TEXT)`,
    );
  });
});

describe("saleLegPredicate", () => {
  test("scopes a gross sale leg: kind + attendee source + revenue dest + event group", () => {
    expect(
      saleLegPredicate(
        sql`la.attendee_id`,
        sql`la.listing_id`,
        sql`la.ledger_event_group`,
      ).sql,
    ).toBe(
      `kind = '${KIND.sale}'` +
        ` AND source_type = '${ATTENDEE}' AND source_id = CAST(la.attendee_id AS TEXT)` +
        ` AND dest_type = '${REVENUE}' AND dest_id = CAST(la.listing_id AS TEXT)` +
        " AND event_group = la.ledger_event_group",
    );
  });
});

describe("signedSumCase", () => {
  test("adds `plus` legs, subtracts `minus` legs, zero otherwise", () => {
    expect(signedSumCase(sql`P`, sql`M`).sql).toBe(
      "COALESCE(SUM(CASE WHEN P THEN amount WHEN M THEN -amount ELSE 0 END), 0)",
    );
  });

  test("keeps the values the predicate fragments bind", () => {
    expect(
      signedSumCase(sql`dest_id = ${"a"}`, sql`source_id = ${"b"}`),
    ).toEqual(
      sql`COALESCE(SUM(CASE WHEN dest_id = ${"a"} THEN amount WHEN source_id = ${"b"} THEN -amount ELSE 0 END), 0)`,
    );
  });
});

describe("creditsLessWriteoffDebits", () => {
  test("sums dest credits minus writeoff-directed source debits, scanning only both legs", () => {
    const credited = `dest_type = '${REVENUE}' AND dest_id = CAST(listing.id AS TEXT) AND (kind IS NULL OR kind NOT IN ('${KIND.refundTaxSale}', '${KIND.refundTaxModifier}'))`;
    const writtenOff =
      `source_type = '${REVENUE}' AND source_id = CAST(listing.id AS TEXT)` +
      ` AND (dest_type = '${WRITEOFF_TYPE}' OR kind IN ('${KIND.taxSale}', '${KIND.taxModifier}'))`;
    expect(creditsLessWriteoffDebits(REVENUE, sql`listing.id`).sql).toBe(
      "(SELECT COALESCE(SUM(" +
        `CASE WHEN ${credited} THEN amount WHEN ${writtenOff} THEN -amount ELSE 0 END` +
        `), 0) FROM transfers WHERE ${credited} OR ${writtenOff})`,
    );
  });
});

describe("accountBalanceSubquery", () => {
  test("is a bare signed-sum subquery over the account's own legs", () => {
    const asDest = `dest_type = '${ATTENDEE}' AND dest_id = CAST(a.id AS TEXT)`;
    const asSource = `source_type = '${ATTENDEE}' AND source_id = CAST(a.id AS TEXT)`;
    expect(accountBalanceSubquery(ATTENDEE, sql`a.id`).sql).toBe(
      `(SELECT COALESCE(SUM(CASE WHEN ${asDest} THEN amount` +
        ` WHEN ${asSource} THEN -amount ELSE 0 END), 0)` +
        ` FROM transfers WHERE ${asDest} OR ${asSource})`,
    );
  });
});

describe("externalCashBalanceSubquery", () => {
  test("adds cash received and subtracts cash returned", () => {
    const received = sql`dest_type = ${sqlLiteral(ATTENDEE)} AND dest_id = CAST(a.id AS TEXT) AND source_type = ${sqlLiteral(WORLD.type)} AND source_id = ${sqlLiteral(WORLD.id)}`;
    const returned = sql`source_type = ${sqlLiteral(ATTENDEE)} AND source_id = CAST(a.id AS TEXT) AND dest_type = ${sqlLiteral(WORLD.type)} AND dest_id = ${sqlLiteral(WORLD.id)}`;
    expect(externalCashBalanceSubquery(ATTENDEE, sql`a.id`).sql).toBe(
      sql`(SELECT ${signedSumCase(received, returned)} FROM transfers WHERE ${received} OR ${returned})`
        .sql,
    );
  });
});

describe("order amount subqueries", () => {
  const expectedTotal = (kinds: readonly string[]): string => {
    const billed = sql`source_type = ${sqlLiteral(ATTENDEE)} AND source_id = CAST(a.id AS TEXT)`;
    const discounted = sql`dest_type = ${sqlLiteral(ATTENDEE)} AND dest_id = CAST(a.id AS TEXT)`;
    const kindList = sqlCommas(kinds.map(sqlLiteral));
    return sql`(SELECT ${signedSumCase(billed, discounted)} FROM transfers WHERE kind IN (${kindList}) AND (${billed} OR ${discounted}))`
      .sql;
  };

  test("keeps fees and manual charges out of the reservation subtotal", () => {
    expect(reservationSubtotalSubquery(ATTENDEE, sql`a.id`).sql).toBe(
      expectedTotal([
        KIND.sale,
        KIND.modifier,
        KIND.taxSale,
        KIND.taxModifier,
        KIND.vat,
      ]),
    );
  });

  test("includes fees, VAT and manual charges in the full order total", () => {
    expect(orderTotalSubquery(ATTENDEE, sql`a.id`).sql).toBe(
      expectedTotal([
        KIND.sale,
        KIND.modifier,
        KIND.taxSale,
        KIND.taxModifier,
        KIND.vat,
        KIND.fee,
        MANUAL_ATTENDEE_CHARGE,
      ]),
    );
  });
});

describe("attendeeOwedSubquery", () => {
  test("is the negation of the attendee's balance subquery", () => {
    expect(attendeeOwedSubquery(sql`a.id`).sql).toBe(
      `-${accountBalanceSubquery(ATTENDEE, sql`a.id`).sql}`,
    );
  });

  test("scopes to the attendee account type, not revenue", () => {
    const { sql: text } = attendeeOwedSubquery(sql`a.id`);
    expect(text.startsWith("-(SELECT")).toBe(true);
    assertStringIncludes(text, `dest_type = '${ATTENDEE}'`);
    assert(!text.includes(`'${REVENUE}'`));
  });
});
