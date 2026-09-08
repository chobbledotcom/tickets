/**
 * The shared attendee-list controls: reading a visitor's choices from a query
 * string, writing them back into links, and the sort orders a list offers.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  ATTENDEE_CHECKIN_CHOICES,
  type AttendeeListSetup,
  type AttendeeListState,
  type AttendeeSort,
  attendeeListCsvHref,
  attendeeListHref,
  attendeeListLink,
  attendeeListOrder,
  attendeeListParams,
  attendeeListSortChoices,
  choiceIsActive,
  compareOptionalDates,
  inDateAndNameOrder,
  inRegistrationOrder,
  isAttendeeSort,
  readAttendeeListState,
} from "#shared/attendee-list-controls.ts";
import {
  testBrowserListSetup,
  testRosterListSetup,
} from "#test-utils/attendee-list.ts";

import { checkBothArms } from "#test-utils/picklist-guard.ts";

const read = <Sort extends AttendeeSort | null>(
  setup: AttendeeListSetup<Sort>,
  query: string,
): AttendeeListState<Sort> =>
  readAttendeeListState(setup, new URLSearchParams(query));

describe("reading the choices from a query string", () => {
  describe("the listing choice", () => {
    test("keeps a chosen listing the setup offers", () => {
      expect(read(testBrowserListSetup(), "listing=7").listingId).toBe(7);
    });

    test("falls back to all listings for an unknown listing", () => {
      expect(
        read(testBrowserListSetup(), "listing=999999").listingId,
      ).toBeNull();
    });

    test("falls back to all listings for a malformed listing", () => {
      expect(read(testBrowserListSetup(), "listing=7x").listingId).toBeNull();
    });

    test("is absent when nothing is chosen", () => {
      expect(read(testBrowserListSetup(), "").listingId).toBeNull();
    });
  });

  describe("the type choice", () => {
    test("keeps a known type", () => {
      expect(read(testBrowserListSetup(), "type=daily").type).toBe("daily");
    });

    test("treats an unknown type as all", () => {
      expect(read(testBrowserListSetup(), "type=bogus").type).toBe("all");
    });

    test("stays all on a list without the type filter", () => {
      expect(read(testRosterListSetup(), "type=daily").type).toBe("all");
    });
  });

  describe("the sort choice", () => {
    test("keeps a known sort", () => {
      expect(read(testBrowserListSetup(), "sort=oldest").sort).toBe("oldest");
    });

    test("falls back to the list's default for a sort we don't know", () => {
      expect(read(testBrowserListSetup(), "sort=sideways").sort).toBe("newest");
    });

    test("falls back to the list's own order when that is the default", () => {
      expect(read(testRosterListSetup(), "sort=sideways").sort).toBeNull();
    });

    test("a roster can still choose a registration order", () => {
      expect(read(testRosterListSetup(), "sort=newest").sort).toBe("newest");
    });
  });

  describe("the check-in choice", () => {
    test("keeps checked-in and checked-out", () => {
      expect(read(testRosterListSetup(), "filter=in").checkin).toBe("in");
      expect(read(testRosterListSetup(), "filter=out").checkin).toBe("out");
    });

    test("shows everyone when the filter is not one we know", () => {
      expect(read(testRosterListSetup(), "filter=sideways").checkin).toBe(
        "all",
      );
    });

    test("shows everyone when the filter is empty", () => {
      expect(read(testRosterListSetup(), "filter=").checkin).toBe("all");
    });

    test("stays all on a list without the check-in filter", () => {
      expect(read(testBrowserListSetup(), "filter=in").checkin).toBe("all");
    });
  });

  describe("the day choice", () => {
    test("keeps a real date on a list with the day filter", () => {
      expect(read(testRosterListSetup(), "date=2026-08-03").date).toBe(
        "2026-08-03",
      );
    });

    test("ignores a date that is not a date, rather than emptying the list", () => {
      expect(read(testRosterListSetup(), "date=not-a-date").date).toBeNull();
    });

    test("ignores an empty date", () => {
      expect(read(testRosterListSetup(), "date=").date).toBeNull();
    });

    test("keeps a well-formed day even when the dropdown does not offer it", () => {
      // A day nobody booked filters to an empty list — the honest answer for
      // that day — and the CSV export reads days with an empty dropdown list.
      expect(read(testRosterListSetup(), "date=2030-01-01").date).toBe(
        "2030-01-01",
      );
    });

    test("ignores a date on a list without the day filter", () => {
      expect(read(testBrowserListSetup(), "date=2026-08-03").date).toBeNull();
    });
  });

  describe("the page choice", () => {
    test("keeps a page number", () => {
      expect(read(testBrowserListSetup(), "page=3").page).toBe(3);
    });

    test("treats a malformed page as the first page", () => {
      expect(read(testBrowserListSetup(), "page=abc").page).toBe(0);
    });

    test("treats a non-positive page as the first page", () => {
      expect(read(testBrowserListSetup(), "page=0").page).toBe(0);
    });

    test("stays on the first page for a list that is not paged", () => {
      expect(read(testRosterListSetup(), "page=3").page).toBe(0);
    });
  });

  test("reads every part of the query together", () => {
    expect(
      read(testRosterListSetup(), "filter=in&date=2026-08-03&sort=oldest"),
    ).toEqual({
      checkin: "in",
      date: "2026-08-03",
      listingId: null,
      page: 0,
      sort: "oldest",
      type: "all",
    });
  });
});

describe("writing the choices back into links", () => {
  test("a state at every default is the bare base path", () => {
    expect(
      attendeeListHref(
        testBrowserListSetup(),
        read(testBrowserListSetup(), ""),
      ),
    ).toBe("/admin/attendees");
  });

  test("writes the non-default choices in a stable order", () => {
    const setup = testBrowserListSetup();
    const state = read(setup, "listing=7&type=daily&sort=oldest&page=2");
    expect(attendeeListHref(setup, state)).toBe(
      "/admin/attendees?listing=7&type=daily&sort=oldest&page=2",
    );
  });

  test("leaves the list's default sort out of the address", () => {
    const setup = testBrowserListSetup();
    expect(attendeeListHref(setup, read(setup, "sort=newest"))).toBe(
      "/admin/attendees",
    );
  });

  test("writes a chosen registration order on a list whose default is its own", () => {
    const setup = testRosterListSetup();
    expect(attendeeListHref(setup, read(setup, "sort=newest"))).toBe(
      "/admin/listing/5/attendees?sort=newest",
    );
  });

  test("writes the check-in and day filters", () => {
    const setup = testRosterListSetup();
    const state = read(setup, "filter=in&date=2026-08-03");
    expect(attendeeListHref(setup, state)).toBe(
      "/admin/listing/5/attendees?filter=in&date=2026-08-03",
    );
  });

  test("lists the non-default parameters as name/value pairs", () => {
    const setup = testRosterListSetup();
    const state = read(setup, "filter=out&sort=oldest");
    expect(attendeeListParams(setup, state)).toEqual([
      ["sort", "oldest"],
      ["filter", "out"],
    ]);
  });
});

describe("links that change a choice", () => {
  test("changing a filter starts back at the first page", () => {
    const setup = testBrowserListSetup();
    const link = attendeeListLink(setup, read(setup, "listing=7&page=4"));
    expect(link({ listingId: null, type: "daily" })).toBe(
      "/admin/attendees?type=daily",
    );
  });

  test("keeps the other choices as they are", () => {
    const setup = testBrowserListSetup();
    const link = attendeeListLink(setup, read(setup, "listing=7&sort=oldest"));
    expect(link({ sort: "newest" })).toBe("/admin/attendees?listing=7");
  });

  test("an explicit page keeps its page number", () => {
    const setup = testBrowserListSetup();
    const link = attendeeListLink(setup, read(setup, "sort=oldest"));
    expect(link({ page: 2 })).toBe("/admin/attendees?sort=oldest&page=2");
  });
});

describe("the CSV download link", () => {
  test("carries the filters but never the sort or page", () => {
    const setup = testBrowserListSetup();
    const state = read(setup, "listing=7&type=daily&sort=oldest&page=2");
    expect(attendeeListCsvHref(setup, state)).toBe(
      "/admin/attendees/csv?listing=7&type=daily",
    );
  });

  test("carries the roster's check-in and day filters", () => {
    const setup = testRosterListSetup();
    const state = read(setup, "filter=in&date=2026-08-03&sort=newest");
    expect(attendeeListCsvHref(setup, state)).toBe(
      "/admin/listing/5/export?filter=in&date=2026-08-03",
    );
  });

  test("is absent for a list without an export", () => {
    const setup = testBrowserListSetup({ csvPath: null });
    expect(attendeeListCsvHref(setup, read(setup, ""))).toBeNull();
  });
});

describe("the sort orders a list offers", () => {
  test("a list whose default is newest offers the two registration orders", () => {
    expect(attendeeListSortChoices(testBrowserListSetup())).toEqual([
      { change: { sort: "newest" }, labelKey: "attendees_list.newest_first" },
      { change: { sort: "oldest" }, labelKey: "attendees_list.oldest_first" },
    ]);
  });

  test("a list with its own order offers it first", () => {
    expect(attendeeListSortChoices(testRosterListSetup())).toEqual([
      { change: { sort: null }, labelKey: "attendees_list.sort_by_date" },
      { change: { sort: "newest" }, labelKey: "attendees_list.newest_first" },
      { change: { sort: "oldest" }, labelKey: "attendees_list.oldest_first" },
    ]);
  });
});

describe("which choice is in force", () => {
  test("a choice is active exactly when the state already holds its change", () => {
    const state = read(testRosterListSetup(), "filter=in");
    expect(choiceIsActive(state, { checkin: "in" })).toBe(true);
    expect(choiceIsActive(state, { checkin: "out" })).toBe(false);
    // The list's own order (sort null) is in force by default.
    expect(choiceIsActive(state, { sort: null })).toBe(true);
    expect(choiceIsActive(state, { sort: "newest" })).toBe(false);
  });

  test("the check-in bar's own choices mark the active one", () => {
    const state = read(testRosterListSetup(), "filter=out");
    expect(
      ATTENDEE_CHECKIN_CHOICES.map((c) => choiceIsActive(state, c.change)),
    ).toEqual([false, false, true]);
  });
});

describe("registration order", () => {
  const rows = [{ id: 2 }, { id: 9 }, { id: 5 }];

  test("newest first puts the highest id at the top", () => {
    expect(inRegistrationOrder("newest")(rows).map((r) => r.id)).toEqual([
      9, 5, 2,
    ]);
  });

  test("oldest first puts the lowest id at the top", () => {
    expect(inRegistrationOrder("oldest")(rows).map((r) => r.id)).toEqual([
      2, 5, 9,
    ]);
  });

  test("leaves the given rows untouched", () => {
    inRegistrationOrder("newest")(rows);
    expect(rows.map((r) => r.id)).toEqual([2, 9, 5]);
  });
});

describe("the booked-date comparison", () => {
  test("orders booked dates ascending", () => {
    expect(compareOptionalDates("2026-08-01", "2026-08-02")).toBeLessThan(0);
    expect(compareOptionalDates("2026-08-02", "2026-08-01")).toBeGreaterThan(0);
    expect(compareOptionalDates("2026-08-01", "2026-08-01")).toBe(0);
  });

  test("sorts a missing date after the booked ones", () => {
    expect(compareOptionalDates(null, "2026-08-01")).toBeGreaterThan(0);
    expect(compareOptionalDates("2026-08-01", null)).toBeLessThan(0);
    expect(compareOptionalDates(null, null)).toBe(0);
  });
});

describe("the table's own date-and-name order", () => {
  const row = (
    id: number,
    date: string | null,
    name: string,
  ): { date: string | null; id: number; name: string } => ({ date, id, name });

  test("orders by booked date, then name, then id", () => {
    const rows = [
      row(3, "2026-08-02", "Later"),
      row(1, "2026-08-01", "Beta"),
      row(2, "2026-08-01", "Alpha"),
    ];
    expect(inDateAndNameOrder(rows).map((r) => r.id)).toEqual([2, 1, 3]);
  });

  test("sorts a booking with no date after the dated ones", () => {
    const rows = [row(1, null, "Undated"), row(2, "2026-08-01", "Dated")];
    expect(inDateAndNameOrder(rows).map((r) => r.id)).toEqual([2, 1]);
  });

  test("breaks equal dates and names by registration id", () => {
    const rows = [
      row(5, "2026-08-01", "Same Name"),
      row(4, "2026-08-01", "Same Name"),
      row(6, "2026-08-01", "Same Name"),
    ];
    expect(inDateAndNameOrder(rows).map((r) => r.id)).toEqual([4, 5, 6]);
  });

  test("leaves the given rows untouched", () => {
    const rows = [row(2, null, "B"), row(1, null, "A")];
    inDateAndNameOrder(rows);
    expect(rows.map((r) => r.id)).toEqual([2, 1]);
  });
});

describe("a roster's row order", () => {
  const rows = [
    { date: null, id: 1, name: "Mid" },
    { date: null, id: 2, name: "Alpha" },
  ];

  test("no sort chosen: the table's own date-and-name order", () => {
    expect(attendeeListOrder(null)(rows).map((r) => r.name)).toEqual([
      "Alpha",
      "Mid",
    ]);
  });

  test("a chosen registration order replaces the default", () => {
    // Newest first: the highest id (Alpha) on top.
    expect(attendeeListOrder("newest")(rows).map((r) => r.name)).toEqual([
      "Alpha",
      "Mid",
    ]);
    expect(attendeeListOrder("oldest")(rows).map((r) => r.name)).toEqual([
      "Mid",
      "Alpha",
    ]);
  });
});

describe("AttendeeSort picklist", () => {
  checkBothArms(
    isAttendeeSort,
    ["newest", "oldest"],
    ["", "new", "old", "recent", "Newest"],
  );
});
