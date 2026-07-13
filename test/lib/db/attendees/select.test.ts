/**
 * Unit tests for the attendee SELECT builder (`src/shared/db/attendees/select.ts`).
 *
 * `attendeeColumns` and `attendeeFromWhere` are pure string builders — no DB —
 * so they are tested directly here. This pins the field-selection contract (the
 * expensive ledger subqueries appear only when their field is requested) and
 * the filter/order SQL that every attendee-listing read now shares, so a mutant
 * that drops a clause, flips a join, or mis-orders the bound args is caught.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ATTENDEE_KIND, SERVICING_KIND } from "#shared/db/attendees/kind.ts";
import {
  ATTENDEE_FIELDS,
  type AttendeeField,
  attendeeColumns,
  attendeeFromWhere,
} from "#shared/db/attendees/select.ts";

const CORE_ALIASES = [
  "attendee.id",
  "attendee.created",
  "attendee.kind",
  "attendee.ticket_token_index",
  "attendee.pii_blob",
  "attendee.status_id",
  "attendee.split_logistics_agents",
  "SUBSTR(listingAttendee.start_at, 1, 10) as date",
];

/** Each opt-in field and the SQL marker that proves it was projected. */
const FIELD_MARKER: Record<AttendeeField, string> = {
  attachment_downloads: "attachment_downloads",
  end_date: "SUBSTR(listingAttendee.end_at, 1, 10) as end_date",
  package_group_id: "package_group_id",
  price_paid: "AS price_paid",
  refunded: "AS refunded",
  remaining_balance: "AS remaining_balance",
};

describe("attendeeColumns", () => {
  test("always emits every core column, for either join", () => {
    for (const join of ["inner", "left"] as const) {
      const cols = attendeeColumns(join, []);
      for (const alias of CORE_ALIASES) expect(cols).toContain(alias);
    }
  });

  test("an empty field set projects no opt-in field", () => {
    const cols = attendeeColumns("inner", []);
    for (const marker of Object.values(FIELD_MARKER)) {
      expect(cols).not.toContain(marker);
    }
  });

  test("each field is projected only when requested", () => {
    for (const field of ATTENDEE_FIELDS) {
      const withField = attendeeColumns("inner", [field]);
      const without = attendeeColumns("inner", []);
      expect(withField).toContain(FIELD_MARKER[field]);
      expect(without).not.toContain(FIELD_MARKER[field]);
    }
  });

  test("the full field set projects all six opt-in fields", () => {
    const cols = attendeeColumns("inner", ATTENDEE_FIELDS);
    for (const marker of Object.values(FIELD_MARKER)) {
      expect(cols).toContain(marker);
    }
  });

  test("a LEFT join COALESCEs the cheap per-listing columns; an INNER join does not", () => {
    const left = attendeeColumns("left", ["attachment_downloads"]);
    expect(left).toContain(
      "COALESCE(listingAttendee.listing_id, 0) as listing_id",
    );
    expect(left).toContain("COALESCE(listingAttendee.quantity, 0) as quantity");
    expect(left).toContain(
      "COALESCE(listingAttendee.checked_in, 0) as checked_in",
    );
    expect(left).toContain(
      "COALESCE(listingAttendee.attachment_downloads, 0) as attachment_downloads",
    );

    const inner = attendeeColumns("inner", ["attachment_downloads"]);
    expect(inner).not.toContain("COALESCE(listingAttendee.listing_id");
    expect(inner).toContain("listingAttendee.listing_id");
    expect(inner).toContain("listingAttendee.attachment_downloads");
  });

  test("omitting the money fields makes the column list strictly shorter", () => {
    expect(attendeeColumns("inner", []).length).toBeLessThan(
      attendeeColumns("inner", ATTENDEE_FIELDS).length,
    );
  });
});

describe("attendeeFromWhere", () => {
  test("uses the requested join keyword", () => {
    expect(attendeeFromWhere("inner", { attendeeIds: [1] }).from).toContain(
      "FROM attendees AS attendee JOIN listing_attendees AS listingAttendee",
    );
    expect(attendeeFromWhere("left", { attendeeIds: [1] }).from).toContain(
      "FROM attendees AS attendee LEFT JOIN listing_attendees AS listingAttendee",
    );
  });

  test("defaults to the regular-attendee kind filter", () => {
    expect(attendeeFromWhere("inner", {}).from).toContain(
      `attendee.kind = '${ATTENDEE_KIND}'`,
    );
  });

  test("each kind filter emits the matching predicate", () => {
    expect(attendeeFromWhere("inner", { kind: "servicing" }).from).toContain(
      `attendee.kind = '${SERVICING_KIND}'`,
    );
    expect(
      attendeeFromWhere("inner", { kind: "attendee-or-servicing" }).from,
    ).toContain(`attendee.kind IN ('${ATTENDEE_KIND}', '${SERVICING_KIND}')`);
  });

  test("a single id is a one-element IN list — one path for one or many", () => {
    const one = attendeeFromWhere("left", { attendeeIds: [9] });
    expect(one.from).toContain("attendee.id IN (?)");
    expect(one.args).toEqual([9]);

    const oneListing = attendeeFromWhere("inner", { listingIds: [5] });
    expect(oneListing.from).toContain("listingAttendee.listing_id IN (?)");
    expect(oneListing.args).toEqual([5]);
  });

  test("an empty id list matches nothing via IN (NULL), never invalid IN ()", () => {
    const attendees = attendeeFromWhere("inner", { attendeeIds: [] });
    expect(attendees.from).toContain("attendee.id IN (NULL)");
    expect(attendees.from).not.toContain("IN ()");
    expect(attendees.args).toEqual([]);

    const listings = attendeeFromWhere("inner", { listingIds: [] });
    expect(listings.from).toContain("listingAttendee.listing_id IN (NULL)");
    expect(listings.from).not.toContain("IN ()");
    expect(listings.args).toEqual([]);
  });

  test("an id list expands to one placeholder each, in order", () => {
    const ids = attendeeFromWhere("inner", { attendeeIds: [3, 1, 2] });
    expect(ids.from).toContain("attendee.id IN (?, ?, ?)");
    expect(ids.args).toEqual([3, 1, 2]);

    const listings = attendeeFromWhere("inner", { listingIds: [7, 8] });
    expect(listings.from).toContain("listingAttendee.listing_id IN (?, ?)");
    expect(listings.args).toEqual([7, 8]);
  });

  test("a package group binds one placeholder", () => {
    const { from, args } = attendeeFromWhere("inner", { packageGroupId: 4 });
    expect(from).toContain("listingAttendee.package_group_id = ?");
    expect(args).toEqual([4]);
  });

  test("realLinesOnly adds the quantity guard only when true", () => {
    expect(attendeeFromWhere("inner", { realLinesOnly: true }).from).toContain(
      "listingAttendee.quantity > 0",
    );
    expect(
      attendeeFromWhere("inner", { realLinesOnly: false }).from,
    ).not.toContain("listingAttendee.quantity > 0");
  });

  test("upcomingFrom keeps undated rows and binds the date", () => {
    const { from, args } = attendeeFromWhere("inner", {
      upcomingFrom: "2026-07-12",
    });
    expect(from).toContain(
      "(listingAttendee.start_at IS NULL OR DATE(listingAttendee.start_at) >= ?)",
    );
    expect(args).toEqual(["2026-07-12"]);
  });

  test("dailyRange adds the listings join and binds before, then after", () => {
    const { from, args } = attendeeFromWhere("inner", {
      dailyRange: {
        after: "2026-07-12T00:00:00Z",
        before: "2026-07-13T00:00:00Z",
      },
    });
    expect(from).toContain(
      "JOIN listings AS listing ON listingAttendee.listing_id = listing.id",
    );
    expect(from).toContain("listing.listing_type = 'daily'");
    expect(from).toContain("listingAttendee.start_at < ?");
    expect(from).toContain("listingAttendee.end_at > ?");
    // before fills the `< ?` bound, after the `> ?` bound.
    expect(args).toEqual(["2026-07-13T00:00:00Z", "2026-07-12T00:00:00Z"]);
  });

  test("an attendee-id subquery is inlined with its own args", () => {
    const { from, args } = attendeeFromWhere("left", {
      attendeeIdsSubquery: {
        args: [10],
        sql: "SELECT newest.id FROM attendees AS newest LIMIT ?",
      },
    });
    expect(from).toContain(
      "attendee.id IN (SELECT newest.id FROM attendees AS newest LIMIT ?)",
    );
    expect(args).toEqual([10]);
  });

  test("mixed filters bind their args in clause order", () => {
    const { args } = attendeeFromWhere("inner", {
      listingIds: [1, 2],
      realLinesOnly: true,
      upcomingFrom: "2026-07-12",
    });
    // kind (no arg), attendeeIds (none), listingIds [1,2], realLinesOnly (none),
    // upcomingFrom ["2026-07-12"].
    expect(args).toEqual([1, 2, "2026-07-12"]);
  });

  test("each named order maps to its ORDER BY, and omitting order omits the clause", () => {
    const cases: [Parameters<typeof attendeeFromWhere>[2], string][] = [
      ["created_desc", "ORDER BY attendee.created DESC"],
      ["id_asc", "ORDER BY attendee.id ASC, listingAttendee.listing_id ASC"],
      ["id_desc", "ORDER BY attendee.id DESC, listingAttendee.listing_id ASC"],
      ["listing_asc", "ORDER BY listingAttendee.listing_id ASC"],
      [
        "start_then_listing",
        "ORDER BY listingAttendee.start_at, listingAttendee.listing_id",
      ],
      [
        "upcoming",
        "ORDER BY COALESCE(listingAttendee.start_at, attendee.created), attendee.id",
      ],
    ];
    for (const [order, sql] of cases) {
      expect(
        attendeeFromWhere("inner", { attendeeIds: [1] }, order).from,
      ).toContain(sql);
    }
    expect(attendeeFromWhere("inner", { attendeeIds: [1] }).from).not.toContain(
      "ORDER BY",
    );
  });
});

describe("attendee SELECT — exact generated SQL", () => {
  // These pin the whole generated string, not just fragments, so any mutation
  // to a column, separator, COALESCE wrapper, ledger subquery, WHERE clause,
  // join keyword, or ORDER BY is caught — a `toContain` check can't see a
  // dropped separator or an inserted token.

  test("the full field set produces the exact column list (all three ledger subqueries inline)", () => {
    expect(attendeeColumns("inner", ATTENDEE_FIELDS)).toBe(
      "attendee.id, attendee.created, attendee.kind, attendee.ticket_token_index, attendee.pii_blob, attendee.status_id, attendee.split_logistics_agents, (SELECT EXISTS(SELECT 1 FROM checkout_stages AS stage WHERE stage.attendee_id = attendee.id AND stage.state = 'pending')) AS pending_checkout, listingAttendee.listing_id, SUBSTR(listingAttendee.start_at, 1, 10) as date, listingAttendee.quantity, listingAttendee.checked_in, -(SELECT COALESCE(SUM(CASE WHEN dest_type = 'attendee' AND dest_id = CAST(attendee.id AS TEXT) THEN amount WHEN source_type = 'attendee' AND source_id = CAST(attendee.id AS TEXT) THEN -amount ELSE 0 END), 0) FROM transfers WHERE dest_type = 'attendee' AND dest_id = CAST(attendee.id AS TEXT) OR source_type = 'attendee' AND source_id = CAST(attendee.id AS TEXT)) AS remaining_balance, (SELECT EXISTS(SELECT 1 FROM transfers WHERE kind = 'refund_cash' AND source_type = 'attendee' AND source_id = CAST(listingAttendee.attendee_id AS TEXT))) AS refunded, COALESCE(CAST((SELECT COALESCE(SUM(amount), 0) FROM transfers WHERE kind = 'sale' AND source_type = 'attendee' AND source_id = CAST(listingAttendee.attendee_id AS TEXT) AND dest_type = 'revenue' AND dest_id = CAST(listingAttendee.listing_id AS TEXT) AND event_group = listingAttendee.ledger_event_group) * (SELECT COALESCE(SUM(sibling.quantity), 0) FROM listing_attendees AS sibling WHERE sibling.attendee_id = listingAttendee.attendee_id AND sibling.listing_id = listingAttendee.listing_id AND sibling.ledger_event_group = listingAttendee.ledger_event_group AND sibling.id <= listingAttendee.id) / NULLIF((SELECT COALESCE(SUM(sibling.quantity), 0) FROM listing_attendees AS sibling WHERE sibling.attendee_id = listingAttendee.attendee_id AND sibling.listing_id = listingAttendee.listing_id AND sibling.ledger_event_group = listingAttendee.ledger_event_group), 0) AS INTEGER) - CAST((SELECT COALESCE(SUM(amount), 0) FROM transfers WHERE kind = 'sale' AND source_type = 'attendee' AND source_id = CAST(listingAttendee.attendee_id AS TEXT) AND dest_type = 'revenue' AND dest_id = CAST(listingAttendee.listing_id AS TEXT) AND event_group = listingAttendee.ledger_event_group) * (SELECT COALESCE(SUM(sibling.quantity), 0) FROM listing_attendees AS sibling WHERE sibling.attendee_id = listingAttendee.attendee_id AND sibling.listing_id = listingAttendee.listing_id AND sibling.ledger_event_group = listingAttendee.ledger_event_group AND sibling.id < listingAttendee.id) / NULLIF((SELECT COALESCE(SUM(sibling.quantity), 0) FROM listing_attendees AS sibling WHERE sibling.attendee_id = listingAttendee.attendee_id AND sibling.listing_id = listingAttendee.listing_id AND sibling.ledger_event_group = listingAttendee.ledger_event_group), 0) AS INTEGER), 0) AS price_paid, SUBSTR(listingAttendee.end_at, 1, 10) as end_date, listingAttendee.attachment_downloads, listingAttendee.package_group_id",
    );
  });

  test("an empty field set under a LEFT join produces the exact core columns", () => {
    expect(attendeeColumns("left", [])).toBe(
      "attendee.id, attendee.created, attendee.kind, attendee.ticket_token_index, attendee.pii_blob, attendee.status_id, attendee.split_logistics_agents, (SELECT EXISTS(SELECT 1 FROM checkout_stages AS stage WHERE stage.attendee_id = attendee.id AND stage.state = 'pending')) AS pending_checkout, COALESCE(listingAttendee.listing_id, 0) as listing_id, SUBSTR(listingAttendee.start_at, 1, 10) as date, COALESCE(listingAttendee.quantity, 0) as quantity, COALESCE(listingAttendee.checked_in, 0) as checked_in",
    );
  });

  test("a multi-filter read builds the exact FROM/WHERE/ORDER, AND-joined", () => {
    expect(
      attendeeFromWhere(
        "inner",
        { listingIds: [1, 2], realLinesOnly: true, upcomingFrom: "2026-07-12" },
        "created_desc",
      ).from,
    ).toBe(
      "FROM attendees AS attendee JOIN listing_attendees AS listingAttendee ON listingAttendee.attendee_id = attendee.id WHERE attendee.kind = 'attendee' AND listingAttendee.listing_id IN (?, ?) AND listingAttendee.quantity > 0 AND (listingAttendee.start_at IS NULL OR DATE(listingAttendee.start_at) >= ?) ORDER BY attendee.created DESC",
    );
  });

  test("a single-attendee LEFT read omits ORDER BY entirely", () => {
    expect(attendeeFromWhere("left", { attendeeIds: [1] }).from).toBe(
      "FROM attendees AS attendee LEFT JOIN listing_attendees AS listingAttendee ON listingAttendee.attendee_id = attendee.id WHERE attendee.kind = 'attendee' AND attendee.id IN (?)",
    );
  });

  test("a daily-range read adds the listings join and the daily guard", () => {
    expect(
      attendeeFromWhere(
        "inner",
        {
          dailyRange: { after: "A", before: "B" },
          kind: "attendee-or-servicing",
          realLinesOnly: true,
        },
        "upcoming",
      ).from,
    ).toBe(
      "FROM attendees AS attendee JOIN listing_attendees AS listingAttendee ON listingAttendee.attendee_id = attendee.id JOIN listings AS listing ON listingAttendee.listing_id = listing.id WHERE attendee.kind IN ('attendee', 'servicing') AND listingAttendee.quantity > 0 AND listing.listing_type = 'daily' AND listingAttendee.start_at < ? AND listingAttendee.end_at > ? ORDER BY COALESCE(listingAttendee.start_at, attendee.created), attendee.id",
    );
  });
});
