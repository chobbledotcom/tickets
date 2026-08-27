import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { ServicingEventSummary } from "#db/attendees/servicing.ts";
import {
  ServicingEventEditLink,
  servicingEventDateLabel,
  upcomingServicingSection,
} from "#templates/admin/servicing-events.tsx";

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
    expect(html).toContain('href="/admin/servicing/12"');
    expect(html).toContain("Summer service");
  });
});

describe("upcomingServicingSection", () => {
  test("opens with the upcoming-events heading", () => {
    const html = upcomingServicingSection([]);
    expect(html).toContain("<details open>");
    expect(html).toContain("<summary>Upcoming service events</summary>");
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
    expect(html).toContain("Saturday 4 July 2026");
    expect(html).toContain("1 listing");
    expect(html).toContain("3");
  });

  test("leaves the date out of the details when none is booked", () => {
    const html = upcomingServicingSection([event({ date: null })]);
    expect(html).not.toContain("· 1 listing");
    expect(html).toContain("1 listing");
  });

  test("shows an empty list when there is nothing upcoming", () => {
    expect(upcomingServicingSection([])).toContain("<ul></ul>");
  });
});
