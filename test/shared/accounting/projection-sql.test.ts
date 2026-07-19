import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  ATTENDEE,
  REVENUE,
  WORLD,
  WRITEOFF_TYPE,
} from "#shared/accounting/accounts.ts";
import { KIND } from "#shared/accounting/kinds.ts";
import { MANUAL_ATTENDEE_CHARGE } from "#shared/accounting/manual-entries.ts";
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
} from "#shared/accounting/projection-sql.ts";

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
    expect(accountPredicate("source", ATTENDEE, "la.attendee_id")).toBe(
      `source_type = '${ATTENDEE}' AND source_id = CAST(la.attendee_id AS TEXT)`,
    );
  });

  test("matches the dest leg using the dest_* columns", () => {
    expect(accountPredicate("dest", REVENUE, "listing.id")).toBe(
      `dest_type = '${REVENUE}' AND dest_id = CAST(listing.id AS TEXT)`,
    );
  });

  test("interpolates the account type verbatim", () => {
    expect(accountPredicate("dest", WRITEOFF_TYPE, "0")).toBe(
      `dest_type = '${WRITEOFF_TYPE}' AND dest_id = CAST(0 AS TEXT)`,
    );
  });
});

describe("saleLegPredicate", () => {
  test("scopes a gross sale leg: kind + attendee source + revenue dest + event group", () => {
    expect(
      saleLegPredicate(
        "la.attendee_id",
        "la.listing_id",
        "la.ledger_event_group",
      ),
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
    expect(signedSumCase("P", "M")).toBe(
      "COALESCE(SUM(CASE WHEN P THEN amount WHEN M THEN -amount ELSE 0 END), 0)",
    );
  });

  test("embeds the predicate fragments verbatim (may carry `?` placeholders)", () => {
    expect(signedSumCase("dest_id = ?", "source_id = ?")).toBe(
      "COALESCE(SUM(CASE WHEN dest_id = ? THEN amount" +
        " WHEN source_id = ? THEN -amount ELSE 0 END), 0)",
    );
  });
});

describe("creditsLessWriteoffDebits", () => {
  test("sums dest credits minus writeoff-directed source debits, scanning only both legs", () => {
    const credited = `dest_type = '${REVENUE}' AND dest_id = CAST(listing.id AS TEXT)`;
    const writtenOff =
      `source_type = '${REVENUE}' AND source_id = CAST(listing.id AS TEXT)` +
      ` AND dest_type = '${WRITEOFF_TYPE}'`;
    expect(creditsLessWriteoffDebits(REVENUE, "listing.id")).toBe(
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
    expect(accountBalanceSubquery(ATTENDEE, "a.id")).toBe(
      `(SELECT COALESCE(SUM(CASE WHEN ${asDest} THEN amount` +
        ` WHEN ${asSource} THEN -amount ELSE 0 END), 0)` +
        ` FROM transfers WHERE ${asDest} OR ${asSource})`,
    );
  });
});

describe("externalCashBalanceSubquery", () => {
  test("adds cash received and subtracts cash returned", () => {
    const received =
      `dest_type = '${ATTENDEE}' AND dest_id = CAST(a.id AS TEXT)` +
      ` AND source_type = '${WORLD.type}' AND source_id = '${WORLD.id}'`;
    const returned =
      `source_type = '${ATTENDEE}' AND source_id = CAST(a.id AS TEXT)` +
      ` AND dest_type = '${WORLD.type}' AND dest_id = '${WORLD.id}'`;
    expect(externalCashBalanceSubquery(ATTENDEE, "a.id")).toBe(
      `(SELECT ${signedSumCase(received, returned)} FROM transfers` +
        ` WHERE ${received} OR ${returned})`,
    );
  });
});

describe("order amount subqueries", () => {
  const expectedTotal = (kinds: readonly string[]): string => {
    const billed = `source_type = '${ATTENDEE}' AND source_id = CAST(a.id AS TEXT)`;
    const discounted = `dest_type = '${ATTENDEE}' AND dest_id = CAST(a.id AS TEXT)`;
    const kindList = kinds.map((kind) => `'${kind}'`).join(", ");
    return (
      `(SELECT ${signedSumCase(billed, discounted)} FROM transfers` +
      ` WHERE kind IN (${kindList}) AND (${billed} OR ${discounted}))`
    );
  };

  test("keeps fees and manual charges out of the reservation subtotal", () => {
    expect(reservationSubtotalSubquery(ATTENDEE, "a.id")).toBe(
      expectedTotal([KIND.sale, KIND.modifier]),
    );
  });

  test("includes fees and manual charges in the full order total", () => {
    expect(orderTotalSubquery(ATTENDEE, "a.id")).toBe(
      expectedTotal([
        KIND.sale,
        KIND.modifier,
        KIND.fee,
        MANUAL_ATTENDEE_CHARGE,
      ]),
    );
  });
});

describe("attendeeOwedSubquery", () => {
  test("is the negation of the attendee's balance subquery", () => {
    expect(attendeeOwedSubquery("a.id")).toBe(
      `-${accountBalanceSubquery(ATTENDEE, "a.id")}`,
    );
  });

  test("scopes to the attendee account type, not revenue", () => {
    const sql = attendeeOwedSubquery("a.id");
    expect(sql.startsWith("-(SELECT")).toBe(true);
    expect(sql).toContain(`dest_type = '${ATTENDEE}'`);
    expect(sql).not.toContain(`'${REVENUE}'`);
  });
});
