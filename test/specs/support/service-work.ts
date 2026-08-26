/**
 * The service work an organiser has coming up: what the Servicing page lists
 * and what their dashboard carries a short version of.
 */

// jscpd:ignore-start

import { organiserReads } from "#test/specs/support/browser.ts";
import { copyFrom } from "#test/specs/support/copy.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { createDailyTestListing } from "#test-utils/db-helpers/listings.ts";
import { createTestServicingEvent } from "#test-utils/servicing.ts";

// jscpd:ignore-end

const SERVICING_PAGE = "/admin/servicing";
const DASHBOARD = "/admin/";

/** How each service event's own row is marked, which is what makes counting
 * the rows possible at all. */
const EVENT_ROW = 'class="servicing-event"';

/** What the site says about service work. */
export const servicingCopy = copyFrom("servicing");

/** What the dashboard says about the work coming up. */
export const dashboardCopy = copyFrom("dashboard");

/** One listing places can be held on. Daily, because service work is held for
 * a day rather than sold as a single fixed thing. */
const roomCalled = (name: string) =>
  createDailyTestListing({ maxAttendees: 10, name });

/** Places held on one or more listings on one day, under one name. The id is
 * kept under that name so a later step can ask whether the page offers a way
 * into it. */
export const holdPlaces = async (
  world: TicketsWorld,
  name: string,
  date: string,
  held: readonly { places: number; room: string }[],
): Promise<void> => {
  const bookings = [];
  for (const { places, room } of held) {
    const listing = await roomCalled(room);
    bookings.push({ date, listingId: listing.id, quantity: places });
  }
  const { id } = await createTestServicingEvent({ bookings, name });
  world.things.remember("record", name, id);
};

/** The address the page uses for one service event, looked up by the name the
 * story called it. */
export const wayInto = (world: TicketsWorld, name: string): string =>
  `href="/admin/servicing/${world.things.require("record", name)}"`;

/** The Servicing page: every service event, with what each one holds. */
export const organiserOpensServicing = organiserReads(() => SERVICING_PAGE);

/** Their dashboard, which carries the short version of the same work. */
export const organiserOpensDashboard = organiserReads(() => DASHBOARD);

/** Just the dashboard block about work still to come. The rest of the page
 * names every listing, and a listing held for a service event is often named
 * after it, so a name found anywhere on the page proves nothing about what is
 * coming up. */
export const workComingUpOn = async (page: string): Promise<string> => {
  const heading = await dashboardCopy(
    "admin.dashboard.upcoming_service_events",
  );
  const start = page.indexOf(heading);
  if (start < 0) throw new Error("The dashboard shows no work coming up");
  const end = page.indexOf("</details>", start);
  if (end < 0) throw new Error("The work coming up never closes");
  return page.slice(start, end);
};

/** One service event's own row on the Servicing page, so a date or a number
 * belonging to another event cannot answer for this one. */
export const rowFor = (
  world: TicketsWorld,
  page: string,
  name: string,
): string => {
  const start = page.indexOf(wayInto(world, name));
  if (start < 0) throw new Error(`The list does not offer "${name}"`);
  return page.slice(start, page.indexOf("</tr>", start));
};

/** How many service events the page lists, counted by the mark each row
 * carries rather than by any one name appearing. */
export const eventsListedOn = (page: string): number =>
  page.split(EVENT_ROW).length - 1;

/** Whether the page lists any service event at all. */
export const anyEventListedOn = (page: string): boolean =>
  page.includes(EVENT_ROW);

/** How many ways into one service event the page offers. */
export const waysIntoOn = (
  world: TicketsWorld,
  page: string,
  name: string,
): number => page.split(wayInto(world, name)).length - 1;
