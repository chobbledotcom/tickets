import { submitTicketForm } from "#test-utils/csrf.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { bookDailyTicket, tomorrow } from "#test/features/admin/calendar-test-helpers.ts";

export async function setupDailyBooking(
  date = tomorrow(),
  opts = { email: "a@test.com", name: "User A" },
) {
  const listing = await createDailyTestListing();
  await bookDailyTicket(listing.slug, { ...opts, date });
  return { date, listing };
}

export async function setupTwoDailyBookings(date = tomorrow()) {
  const listing1 = await createDailyTestListing();
  const listing2 = await createDailyTestListing();
  await bookDailyTicket(listing1.slug, {
    date,
    email: "a@test.com",
    name: "User A",
  });
  await bookDailyTicket(listing2.slug, {
    date,
    email: "b@test.com",
    name: "User B",
  });
  return { date, listing1, listing2 };
}

export async function setupMixedBookings(
  listingDate: string,
  dailyName = "Daily User",
  standardName = "Standard User",
) {
  const dailyListing = await createDailyTestListing();
  const standardListing = await createTestListing({
    date: `${listingDate}T10:00`,
    name: "Workshop",
  });
  await bookDailyTicket(dailyListing.slug, {
    date: listingDate,
    email: `${dailyName.toLowerCase().replace(" ", "")}@test.com`,
    name: dailyName,
  });
  await submitTicketForm(standardListing.slug, {
    email: `${standardName.toLowerCase().replace(" ", "")}@test.com`,
    name: standardName,
  });
  return { dailyListing, listingDate, standardListing };
}
