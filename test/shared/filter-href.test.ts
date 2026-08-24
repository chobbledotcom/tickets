import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  filterHref,
  filterParams,
  type ParamWriter,
} from "#shared/filter-href.ts";

type View = { agent: string; date: string | null; page: number };

const WRITERS: ParamWriter<View>[] = [
  { name: "date", value: ({ date }) => date },
  { name: "agent", value: ({ agent }) => (agent === "all" ? null : agent) },
  { name: "page", value: ({ page }) => (page > 0 ? String(page) : null) },
];

const view = (overrides: Partial<View> = {}): View => ({
  agent: "all",
  date: null,
  page: 0,
  ...overrides,
});

describe("filter href", () => {
  test("writes nothing for a state at every default", () => {
    expect(filterParams(WRITERS, view())).toEqual([]);
  });

  test("writes only the parameters that are off their default", () => {
    expect(
      filterParams(WRITERS, view({ agent: "3", date: "2026-07-06" })),
    ).toEqual([
      ["date", "2026-07-06"],
      ["agent", "3"],
    ]);
  });

  test("keeps the declared order rather than the state's", () => {
    expect(
      filterParams(WRITERS, view({ agent: "3", date: "2026-07-06", page: 2 })),
    ).toEqual([
      ["date", "2026-07-06"],
      ["agent", "3"],
      ["page", "2"],
    ]);
  });

  test("gives a default state the bare path", () => {
    expect(filterHref(WRITERS, "/admin/calendar", view())).toBe(
      "/admin/calendar",
    );
  });

  test("adds an anchor to a bare path without a question mark", () => {
    expect(filterHref(WRITERS, "/admin/calendar", view(), "#attendees")).toBe(
      "/admin/calendar#attendees",
    );
  });

  test("puts the query before the anchor", () => {
    expect(
      filterHref(
        WRITERS,
        "/admin/calendar",
        view({ agent: "3", date: "2026-07-06" }),
        "#attendees",
      ),
    ).toBe("/admin/calendar?date=2026-07-06&agent=3#attendees");
  });

  test("escapes a value that would otherwise break the query", () => {
    expect(
      filterHref(WRITERS, "/admin/calendar", view({ agent: "a&b=c" })),
    ).toBe("/admin/calendar?agent=a%26b%3Dc");
  });

  // The point of the whole module: a link states the change, and every other
  // filter comes along because nobody has to remember it.
  test("carries the filters a change does not name", () => {
    const current = view({ agent: "3", date: "2026-07-06", page: 4 });

    expect(
      filterHref(
        WRITERS,
        "/admin/calendar",
        { ...current, date: "2026-07-07" },
        "#attendees",
      ),
    ).toBe("/admin/calendar?date=2026-07-07&agent=3&page=4#attendees");
  });
});
