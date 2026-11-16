import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { buildCapacityCheckedInsert } from "#db/attendees/capacity/checks.ts";
import { dateToStartEnd } from "#db/attendees/capacity/range.ts";
import { sql } from "#db/sql.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";

/** The exact argument list `buildCapacityCheckedInsert` receives. */
type InsertCall = Parameters<typeof buildCapacityCheckedInsert>;

/** A statement whose clause the caller's flags decide, and the clause it must
 *  carry: null means the statement has no WHERE at all. */
type ClauseCase = {
  title: string;
  call: InsertCall;
  where: string | null;
};

describe("buildCapacityCheckedInsert", () => {
  test("binds every default booking fact in statement order", () => {
    const { startAt, endAt } = dateToStartEnd("2026-06-24", 1);
    const statement = buildCapacityCheckedInsert({
      date: "2026-06-24",
      listingId: 17,
    });

    expect(statement.args).toEqual([endAt, 17, "", 0, 1, startAt]);
    // Both zero defaults (package_group_id and parent_listing_id) share the
    // interned ?4 slot. The capacity clause binds nothing new.
    expectIncludesAll(statement.sql, [
      "(attendee_id, end_at, listing_id, order_token, package_group_id, parent_listing_id, quantity, start_at)",
      "SELECT last_insert_rowid(), ?1, ?2, ?3, ?4, ?4, ?5, ?6",
      "WHERE",
    ]);
  });

  test("binds a supplied attendee before custom booking facts", () => {
    const { startAt, endAt } = dateToStartEnd("2026-06-24", 2);
    const statement = buildCapacityCheckedInsert(
      {
        date: "2026-06-24",
        durationDays: 2,
        listingId: 17,
        orderToken: "order-17",
        packageGroupId: 23,
        parentListingId: 19,
        quantity: 3,
      },
      41,
      true,
    );

    expect(statement.args).toEqual([
      41,
      endAt,
      17,
      "order-17",
      23,
      19,
      3,
      startAt,
    ]);
    assertStringIncludes(
      statement.sql,
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    );
  });

  // A line that books no places cannot make any capacity state worse, so it
  // can land on a full or inactive listing too; its clause only asks that the
  // listing row still exists. An overbook caller always lands its row — the
  // payment ghost store's documented contract, even against a listing deleted
  // since checkout.
  // The listing id takes the slot after the attendee and end_at values.
  const existsClause = (slot: number): string =>
    `WHERE EXISTS (SELECT 1 FROM listings AS listing WHERE listing.id = ?${slot})`;
  const cases: ClauseCase[] = [
    {
      call: [{ date: "2026-06-24", listingId: 17 }, 41, true],
      title: "omits the capacity clause when overbooking is allowed",
      where: null,
    },
    {
      call: [{ date: "2026-06-24", listingId: 17, quantity: 0 }],
      title: "a zero-quantity booking carries no capacity or active condition",
      where: existsClause(2),
    },
    {
      call: [{ date: "2026-06-24", listingId: 17, quantity: 0 }, 41, true],
      title: "an overbook caller writes a zero-quantity ghost unconditionally",
      where: null,
    },
    {
      call: [
        { date: "2026-06-24", listingId: 17, quantity: 2 },
        41,
        true,
        sql`order_not_yet_recorded`,
      ],
      title: "an overbook caller keeps an extra condition the caller passed",
      where: "WHERE order_not_yet_recorded",
    },
    {
      call: [
        { date: "2026-06-24", listingId: 17, quantity: 0 },
        41,
        false,
        sql`order_not_yet_recorded`,
      ],
      title:
        "a zero-quantity booking keeps an extra condition the caller passed",
      where: `${existsClause(3)} AND (order_not_yet_recorded)`,
    },
  ];

  for (const { call, title, where } of cases) {
    test(title, () => {
      const statement = buildCapacityCheckedInsert(...call);

      if (where === null) {
        assert(!statement.sql.includes("WHERE"));
        return;
      }
      assertStringIncludes(statement.sql, where);
      assert(!statement.sql.includes("max_attendees"));
      assert(!statement.sql.includes("active = 1"));
    });
  }
});
