/**
 * Aiming a bulk email at one day of a listing booked by the day: how the target
 * is read off a request, and who it reaches once it is.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  resolveRecipientEmails,
  targetFromForm,
  targetFromQuery,
  targetQuery,
} from "#shared/bulk-email.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { FormParams } from "#shared/form-data.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createDailyTestListing } from "#test-utils/db-helpers/listings.ts";

const MONDAY = "2026-03-02";
const TUESDAY = "2026-03-03";
const NEXT_MONDAY = "2026-03-09";

/** A booking on a daily listing that starts on `date` and lasts `days`. The
 * test writes it through the same atomic create the booking path uses, so the
 * stored day range is the one a real booking would leave behind. */
const bookDays = async (
  listingId: number,
  name: string,
  email: string,
  date: string,
  durationDays = 1,
): Promise<void> => {
  const result = await attendeesApi.createAttendeeAtomic({
    address: "",
    bookings: [
      { date, durationDays, listingId, packageGroupId: 0, quantity: 1 },
    ],
    email,
    name,
    phone: "",
    special_instructions: "",
  });
  if (!result.success) {
    throw new Error(`Failed to book ${name}: ${result.reason}`);
  }
};

/** A listing with one booking on each of two days a week apart — the setup for
 * telling "this day only" apart from "the whole listing". */
const bookedOnTwoDays = async (): Promise<{ id: number }> => {
  const listing = await createDailyTestListing({ name: "Term" });
  await bookDays(listing.id, "Rachel", "rachel@example.com", MONDAY);
  await bookDays(listing.id, "Marco", "marco@example.com", NEXT_MONDAY);
  return listing;
};

/** Who a target reaches, as the compose page would resolve it. */
const reaches = async (
  target: Parameters<typeof resolveRecipientEmails>[0],
): Promise<string[]> =>
  (await resolveRecipientEmails(target, await getTestPrivateKey())).toSorted();

describeWithEnv("bulk-email listing-day target", { db: true }, () => {
  test("parses a day from query and form fields", async () => {
    const listing = await createDailyTestListing({ name: "Term" });
    const expected = {
      day: MONDAY,
      kind: "listing-day",
      listingId: listing.id,
    };

    await expect(
      targetFromQuery(
        new URLSearchParams({ day: MONDAY, listing: String(listing.id) }),
      ),
    ).resolves.toEqual(expected);
    await expect(
      targetFromForm(
        new FormParams({ day: MONDAY, listing_id: String(listing.id) }),
      ),
    ).resolves.toEqual(expected);
  });

  test("round-trips through the query string it is linked by", async () => {
    const listing = await createDailyTestListing({ name: "Term" });
    const target = {
      day: MONDAY,
      kind: "listing-day" as const,
      listingId: listing.id,
    };

    await expect(
      targetFromQuery(new URLSearchParams(targetQuery(target))),
    ).resolves.toEqual(target);
  });

  test("a request that names no day is still the whole listing", async () => {
    const listing = await createDailyTestListing({ name: "Term" });
    const expected = { kind: "listing", listingId: listing.id };

    await expect(
      targetFromQuery(new URLSearchParams({ listing: String(listing.id) })),
    ).resolves.toEqual(expected);
    await expect(
      targetFromForm(new FormParams({ listing_id: String(listing.id) })),
    ).resolves.toEqual(expected);
  });

  test("refuses a day it cannot honour rather than reaching more people", async () => {
    const listing = await createDailyTestListing({ name: "Term" });
    const id = String(listing.id);

    // A named-but-unusable day is refused. Widening is what makes this matter:
    // a blank day beside a listing would otherwise reach the whole listing, and
    // a day with no listing beside it would reach the default audience.
    for (const params of [
      { day: "2026-02-30", listing: id },
      { day: "not-a-day", listing: id },
      { day: "2026-3-2", listing: id },
      { day: "", listing: id },
      { day: MONDAY, listing: "" },
      { day: MONDAY },
      { day: MONDAY, listing: "999999" },
    ]) {
      await expect(
        targetFromQuery(new URLSearchParams(params)),
      ).resolves.toBeNull();
    }
    await expect(
      targetFromForm(new FormParams({ day: "", listing_id: id })),
    ).resolves.toBeNull();
    await expect(
      targetFromForm(new FormParams({ day: MONDAY })),
    ).resolves.toBeNull();
  });

  test("reaches the people booked on that day and nobody else", async () => {
    const listing = await bookedOnTwoDays();

    expect(
      await reaches({
        day: MONDAY,
        kind: "listing-day",
        listingId: listing.id,
      }),
    ).toEqual(["rachel@example.com"]);
  });

  test("a booking covering several days answers to each of them", async () => {
    const listing = await createDailyTestListing({ name: "Hall" });
    await bookDays(listing.id, "Priya", "priya@example.com", MONDAY, 3);

    for (const day of [MONDAY, TUESDAY]) {
      expect(
        await reaches({ day, kind: "listing-day", listingId: listing.id }),
      ).toEqual(["priya@example.com"]);
    }
    expect(
      await reaches({
        day: NEXT_MONDAY,
        kind: "listing-day",
        listingId: listing.id,
      }),
    ).toEqual([]);
  });

  test("the whole listing still reaches every day", async () => {
    const listing = await bookedOnTwoDays();

    expect(await reaches({ kind: "listing", listingId: listing.id })).toEqual([
      "marco@example.com",
      "rachel@example.com",
    ]);
  });
});
