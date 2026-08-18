/**
 * The roster's sort choices: its own date-and-name order by default, with
 * newest-first and oldest-first registration order a click away.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  detailHtml,
  registerListingTemplateHooks,
} from "#test/ui/templates/admin/listings/helpers.ts";
import { testAttendee, testListingWithCount } from "#test-utils/factories.ts";

const listing = () => testListingWithCount({ attendee_count: 3 });

/** Ids (registration order) and names are arranged so the name order, the
 *  newest-first order, and the oldest-first order are three different rows. */
const trio = () => [
  testAttendee({ id: 1, name: "Mid Person" }),
  testAttendee({ id: 2, name: "Alpha Person" }),
  testAttendee({ id: 3, name: "Zulu Person" }),
];

/** The three names in the order the page shows them. */
const shownOrder = (html: string): string[] =>
  ["Mid Person", "Alpha Person", "Zulu Person"]
    .map((name) => {
      const at = html.indexOf(name);
      expect(at).toBeGreaterThan(-1);
      return { at, name };
    })
    .sort((a, b) => a.at - b.at)
    .map(({ name }) => name);

describe("adminListingPage roster sort", () => {
  registerListingTemplateHooks();

  test("offers its own order plus the two registration orders", () => {
    const html = detailHtml(listing(), { attendees: trio() });
    expect(html).toContain("Sort: <strong><u>By date and name</u></strong>");
    expect(html).toContain(
      'href="/admin/listing/1/attendees?sort=newest">Newest first</a>',
    );
    expect(html).toContain(
      'href="/admin/listing/1/attendees?sort=oldest">Oldest first</a>',
    );
  });

  test("orders by name (its own order) when no sort is chosen", () => {
    const html = detailHtml(listing(), { attendees: trio() });
    expect(shownOrder(html)).toEqual([
      "Alpha Person",
      "Mid Person",
      "Zulu Person",
    ]);
  });

  test("newest first puts the latest registration on top", () => {
    const html = detailHtml(listing(), { attendees: trio(), sort: "newest" });
    expect(shownOrder(html)).toEqual([
      "Zulu Person",
      "Alpha Person",
      "Mid Person",
    ]);
    expect(html).toContain("<strong><u>Newest first</u></strong>");
  });

  test("oldest first puts the earliest registration on top", () => {
    const html = detailHtml(listing(), { attendees: trio(), sort: "oldest" });
    expect(shownOrder(html)).toEqual([
      "Mid Person",
      "Alpha Person",
      "Zulu Person",
    ]);
  });

  test("a check-in press returns to the sorted view", () => {
    const html = detailHtml(listing(), {
      attendees: [testAttendee({ id: 1 })],
      sort: "newest",
    });
    expect(html).toContain('value="/admin/listing/1/attendees?sort=newest"');
  });
});
