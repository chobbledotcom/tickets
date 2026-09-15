/**
 * Writing a visitor's choices for an attendee list back into its links.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  ATTENDEE_CHECKIN_CHOICES,
  attendeeListCsvHref,
  attendeeListHref,
  attendeeListLink,
  attendeeListParams,
  attendeeListSortChoices,
  choiceIsActive,
} from "#shared/attendee-list-controls.ts";
import {
  readListState as read,
  testBrowserListSetup,
  testRosterListSetup,
} from "#test-utils/attendee-list.ts";

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

  test("writes the first page as a page number", () => {
    const setup = testBrowserListSetup();
    expect(attendeeListHref(setup, read(setup, "page=1"))).toBe(
      "/admin/attendees?page=1",
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

  test("the check-in bar's choices carry the catalog labels", () => {
    expect(ATTENDEE_CHECKIN_CHOICES.map((c) => c.labelKey)).toEqual([
      "listings_table.all",
      "common.checked_in",
      "listings_table.checked_out",
    ]);
  });
});
