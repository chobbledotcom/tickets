import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { buildCapacityCheckedInsert } from "#db/attendees/capacity/checks.ts";
import { dateToStartEnd } from "#db/attendees/capacity/range.ts";

describe("buildCapacityCheckedInsert", () => {
  test("binds every default booking fact in statement order", () => {
    const { startAt, endAt } = dateToStartEnd("2026-06-24", 1);
    const statement = buildCapacityCheckedInsert({
      date: "2026-06-24",
      listingId: 17,
    });

    expect(statement.args.slice(0, 7)).toEqual([
      17,
      startAt,
      endAt,
      1,
      "",
      0,
      0,
    ]);
    expect(statement.sql).toContain(
      "SELECT ?1, last_insert_rowid(), ?2, ?3, ?4, ?5, ?6, ?7",
    );
    expect(statement.sql).toContain("WHERE");
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
      (bind) => bind(41),
      true,
    );

    expect(statement.args).toEqual([
      17,
      41,
      startAt,
      endAt,
      3,
      "order-17",
      19,
      23,
    ]);
    expect(statement.sql).toContain("SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8");
  });

  test("omits the capacity clause when overbooking is allowed", () => {
    const statement = buildCapacityCheckedInsert(
      { date: "2026-06-24", listingId: 17 },
      (bind) => bind(41),
      true,
    );

    expect(statement.sql).not.toContain("WHERE");
  });

  test("a zero-quantity booking carries no capacity or active condition", () => {
    // A line that books no places cannot make any capacity state worse, so
    // its insert is unconditional — the row must land on a full or inactive
    // listing too.
    const statement = buildCapacityCheckedInsert({
      date: "2026-06-24",
      listingId: 17,
      quantity: 0,
    });

    expect(statement.sql).not.toContain("WHERE");
  });

  test("a zero-quantity booking keeps an extra condition the caller passed", () => {
    const statement = buildCapacityCheckedInsert(
      { date: "2026-06-24", listingId: 17, quantity: 0 },
      (bind) => bind(41),
      false,
      () => "order_not_yet_recorded",
    );

    expect(statement.sql).toContain("WHERE");
    expect(statement.sql).toContain("order_not_yet_recorded");
    expect(statement.sql).not.toContain("max_attendees");
  });
});
