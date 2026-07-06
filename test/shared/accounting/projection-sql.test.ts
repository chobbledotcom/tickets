import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  ATTENDEE,
  REVENUE,
  WRITEOFF_TYPE,
} from "#shared/accounting/accounts.ts";
import { KIND } from "#shared/accounting/kinds.ts";
import {
  MANUAL_LISTING_COST,
  MANUAL_LISTING_INCOME,
} from "#shared/accounting/manual-entries.ts";
import {
  accountBalanceSubquery,
  accountPredicate,
  attendeeOwedSubquery,
  creditsLessWriteoffDebits,
  LEG_COLUMNS,
  revenueBreakdownColumns,
  revenueBreakdownScope,
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

describe("revenueBreakdownColumns", () => {
  test("emits the six comma-separated conditional-sum columns in order", () => {
    const credited = `dest_type = '${REVENUE}' AND dest_id = CAST(listing.id AS TEXT)`;
    const debited = `source_type = '${REVENUE}' AND source_id = CAST(listing.id AS TEXT)`;
    const col = (where: string, alias: string) =>
      `COALESCE(SUM(CASE WHEN ${where} THEN amount ELSE 0 END), 0) AS ${alias}`;
    expect(revenueBreakdownColumns("listing.id")).toBe(
      [
        col(`kind = '${KIND.sale}' AND ${credited}`, "gross_sales"),
        col(
          `kind = '${MANUAL_LISTING_INCOME}' AND ${credited}`,
          "external_income",
        ),
        col(
          `kind = '${KIND.adjustment}' AND ${credited} AND source_type = '${WRITEOFF_TYPE}'`,
          "write_ups",
        ),
        col(
          `kind = '${KIND.adjustment}' AND ${debited} AND dest_type = '${WRITEOFF_TYPE}'`,
          "write_downs",
        ),
        col(`kind = '${KIND.refundSale}' AND ${debited}`, "refunds"),
        col(`kind = '${MANUAL_LISTING_COST}' AND ${debited}`, "external_costs"),
      ].join(", "),
    );
  });

  test("labels each column with its documented alias", () => {
    const sql = revenueBreakdownColumns("x");
    expect(sql).toContain("AS gross_sales");
    expect(sql).toContain("AS external_income");
    expect(sql).toContain("AS write_ups");
    expect(sql).toContain("AS write_downs");
    expect(sql).toContain("AS refunds");
    expect(sql).toContain("AS external_costs");
  });
});

describe("revenueBreakdownScope", () => {
  test("matches rows where the revenue account is either leg", () => {
    expect(revenueBreakdownScope("listing.id")).toBe(
      `dest_type = '${REVENUE}' AND dest_id = CAST(listing.id AS TEXT)` +
        ` OR source_type = '${REVENUE}' AND source_id = CAST(listing.id AS TEXT)`,
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
