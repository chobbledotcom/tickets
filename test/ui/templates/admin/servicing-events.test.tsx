import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { ServicingEventSummary } from "#db/attendees/servicing.ts";
import {
  ServicingEventEditLink,
  servicingEventDateLabel,
  upcomingServicingSection,
} from "#templates/admin/servicing-events.tsx";
import { says } from "#test-utils/says.ts";

const event = (over: Partial<ServicingEventSummary> = {}) =>
  ({
    bookings: [{ listingId: 1, quantity: 1 }],
    date: "2026-07-04",
    id: 12,
    name: "Summer service",
    totalQuantity: 3,
    ...over,
  }) as ServicingEventSummary;

describe("servicingEventDateLabel", () => {
  test("shows a booked date as a short label", () => {
    expect(servicingEventDateLabel("2026-07-04")).toBe("Saturday 4 July 2026");
  });

  test("shows nothing when no date is booked yet", () => {
    expect(servicingEventDateLabel(null)).toBe("");
  });
});

describe("ServicingEventEditLink", () => {
  test("links to the event's edit page, labelled with its name", () => {
    const html = String(
      ServicingEventEditLink({ event: { id: 12, name: "Summer service" } }),
    );
    says(html, 'href="/admin/servicing/12"');
    says(html, "Summer service");
  });
});

describe("upcomingServicingSection", () => {
  test("opens with the upcoming-events heading", () => {
    const html = upcomingServicingSection([]);
    says(html, "<details open>");
    says(html, "<summary>Upcoming service events</summary>");
  });

  test("shows one line per event, not one per booking line", () => {
    const html = upcomingServicingSection([
      event({
        bookings: [
          { listingId: 1, quantity: 1 },
          { listingId: 2, quantity: 2 },
        ],
      }),
    ]);
    expect(html.split("<li>").length - 1).toBe(1);
  });

  test("shows the date, the listing count and the total quantity", () => {
    const html = upcomingServicingSection([event()]);
    says(html, "Saturday 4 July 2026");
    says(html, "1 listing");
    says(html, "3");
  });

  test("leaves the date out of the details when none is booked", () => {
    const html = upcomingServicingSection([event({ date: null })]);
    assert(!html.includes("· 1 listing"));
    says(html, "1 listing");
  });

  test("shows an empty list when there is nothing upcoming", () => {
    says(upcomingServicingSection([]), "<ul></ul>");
  });
});
