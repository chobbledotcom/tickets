/**
 * When the roster offers "Email this date's attendees". Each case it withholds
 * the link for is a page the link would otherwise break on.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { emailDayHrefFor } from "#templates/admin/listings/attendees.tsx";
import { testAttendee } from "#test-utils/factories.ts";

const DAY = "2026-03-02";
const bookedBy = (email: string, quantity = 1) =>
  testAttendee({ email, quantity });

describe("emailDayHrefFor", () => {
  test("links an owner to the day's compose page", () => {
    expect(
      emailDayHrefFor(7, DAY, true, [bookedBy("rachel@example.com")]),
    ).toBe("/admin/emails?listing=7&day=2026-03-02");
  });

  test("offers nothing when no date is chosen", () => {
    // Without a date the listing's own Email action already covers every date.
    expect(
      emailDayHrefFor(7, null, true, [bookedBy("rachel@example.com")]),
    ).toBeUndefined();
  });

  test("offers nothing to a manager", () => {
    // A manager can open this roster but not /admin/emails.
    expect(
      emailDayHrefFor(7, DAY, false, [bookedBy("rachel@example.com")]),
    ).toBeUndefined();
  });

  test("offers nothing when nobody on the day has an email", () => {
    // The compose page 404s on an empty recipient set.
    expect(emailDayHrefFor(7, DAY, true, [])).toBeUndefined();
    expect(emailDayHrefFor(7, DAY, true, [bookedBy("")])).toBeUndefined();
    expect(emailDayHrefFor(7, DAY, true, [bookedBy("  ")])).toBeUndefined();
  });

  test("ignores a booking that holds no ticket", () => {
    // The recipient query counts only rows with a quantity, so a quantity-0
    // row on its own is nobody to write to.
    expect(
      emailDayHrefFor(7, DAY, true, [bookedBy("rachel@example.com", 0)]),
    ).toBeUndefined();
  });
});
