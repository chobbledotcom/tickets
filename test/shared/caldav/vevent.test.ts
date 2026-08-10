import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  buildListingEvent,
  type MirrorListing,
} from "#shared/caldav/vevent.ts";

const listing = (over: Partial<MirrorListing> = {}): MirrorListing => ({
  date: "2026-08-10T09:30:00.000Z",
  description: "Come along",
  id: 42,
  location: "Main Hall",
  name: "Summer Fair",
  ...over,
});

const build = (over: Partial<Parameters<typeof buildListingEvent>[0]> = {}) =>
  buildListingEvent({
    dtstamp: "2026-08-01T00:00:00.000Z",
    listing: listing(),
    namespace: "ns123",
    ticketUrl: "https://tickets.example/ticket/summer-fair",
    ...over,
  });

const lines = (ics: string): string[] => ics.split("\r\n");

describe("buildListingEvent", () => {
  test("wraps one VEVENT in a complete VCALENDAR envelope", () => {
    expect(lines(build())).toEqual([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Chobble Tickets//EN",
      "BEGIN:VEVENT",
      "UID:listing-42@ns123",
      "DTSTAMP:20260801T000000Z",
      "SUMMARY:Summer Fair",
      "DESCRIPTION:Come along",
      "URL:https://tickets.example/ticket/summer-fair",
      "DTSTART:20260810T093000Z",
      "LOCATION:Main Hall",
      "END:VEVENT",
      "END:VCALENDAR",
    ]);
  });

  test("keys the UID on the listing id and the stored namespace", () => {
    expect(build({ listing: listing({ id: 7 }), namespace: "abc" })).toContain(
      "UID:listing-7@abc",
    );
  });

  test("omits the URL line for a listing the public gate rejects", () => {
    const out = build({ ticketUrl: null });
    expect(out).not.toContain("URL:");
    expect(out).toContain("SUMMARY:Summer Fair");
  });

  test("omits the DESCRIPTION line when the listing has no description", () => {
    const out = build({ listing: listing({ description: "" }) });
    expect(out).not.toContain("DESCRIPTION:");
  });

  test("never carries attendee data — no attendee UID or admin URL", () => {
    const out = build();
    expect(out).not.toContain("attendee-");
    expect(out).not.toContain("/admin/");
  });

  test("escapes special characters in the summary", () => {
    const out = build({ listing: listing({ name: "Food, Drink; Fun" }) });
    expect(out).toContain("SUMMARY:Food\\, Drink\\; Fun");
  });
});
