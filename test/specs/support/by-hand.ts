/**
 * Bookings the organiser makes themselves, and the attendee list they download.
 * Both are driven through the listing's own roster page, so a page that stops
 * offering the form or the download fails the story.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { leaveEvidencePage } from "#scripts/specs/evidence/pages.ts";
import { openAdminPage } from "#test/specs/support/browser.ts";
import { listingIdNamed } from "#test/specs/support/listings.ts";
import type { BookingChoices } from "#test/specs/support/public-booking.ts";
import type {
  ReadAboutOneThing,
  TicketsWorld,
} from "#test/specs/support/world.ts";

// jscpd:ignore-end

/** The listing's roster — where the add form and the download both live. */
const rosterPath = (world: TicketsWorld, name: string): string =>
  `/admin/listing/${listingIdNamed(world, name)}/attendees`;

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/** The CSV is the outcome this story reads. Render that exact text in the
 * evidence browser so its screenshot proves the date range in the download. */
const csvEvidencePage = (name: string, csv: string): string =>
  `data:text/html,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><style>body{background:#f3f4ef;color:#273320;font:16px Arial,sans-serif;margin:0;padding:32px}main{background:#fff;border:1px solid #d7e1cf;border-top:6px solid #568038;border-radius:8px;box-shadow:0 12px 28px #2f4a2024;margin:auto;max-width:720px;padding:24px}h1{font-size:24px;margin:0 0 20px}pre{background:#f1f5ed;border:1px solid #d7e1cf;overflow-wrap:anywhere;padding:16px;white-space:pre-wrap}</style><main><h1>${escapeHtml(name)} attendee CSV</h1><pre>${escapeHtml(csv)}</pre></main>`)}`;

/** The organiser adds a booking through the form on the listing's roster. Keeps
 * the page they land on, so a story can read what they were told. */
export const organiserAddsBooking = async (
  world: TicketsWorld,
  name: string,
  booking: BookingChoices,
): Promise<void> => {
  const browser = await openAdminPage(world, rosterPath(world, name));
  // The form must offer a day, or the organiser could not say when the stay
  // starts and the booking would silently land on the wrong days.
  if (booking.day !== undefined) {
    expect(browser.currentHtml).toContain('name="date"');
  }
  await browser.submitForm(
    {
      email: booking.email,
      name: booking.who,
      quantity: String(booking.places ?? 1),
      ...(booking.day === undefined ? {} : { date: booking.day }),
      ...(booking.dayCount === undefined
        ? {}
        : { day_count: String(booking.dayCount) }),
    },
    "Add Attendee",
  );
};

/** The attendee list the organiser downloads from the listing's roster, as the
 * text of the file itself. Followed from the link on the page, so a story can
 * never read a file the organiser has no way to reach. */
export const downloadAttendeeList: ReadAboutOneThing = async (world, name) => {
  const path = rosterPath(world, name);
  const browser = await openAdminPage(world, path);
  const download = browser.links.find(({ href }) => href.includes("/export"));
  if (!download) {
    throw new Error(`The ${name} roster offers no attendee list to download`);
  }
  const csv = new TextDecoder().decode(
    await browser.downloadBytes(download.href),
  );
  leaveEvidencePage(world, ["attendee-csv-export"], csvEvidencePage(name, csv));
  return csv;
};
