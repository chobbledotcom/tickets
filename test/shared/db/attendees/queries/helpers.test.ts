import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { createAttendeeAtomicImpl } from "#shared/db/attendees/create.ts";
import {
  ATTENDEES_PAGE_SIZE,
  attendeeIdByLedgerEventGroup,
  getAttendeeKindsByIds,
  getAttendeeNamesByIds,
  getAttendeePackageRowsRaw,
  getAttendeesByIds,
  getAttendeesPage,
  hasPaidLine,
  isAttendeeSort,
  LISTING_ATTENDEE_ROW_COLS,
} from "#shared/db/attendees/queries.ts";
import { getDb } from "#shared/db/client.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { postListingSale } from "#test-utils/ledger.ts";

test("exports the attendee browsing constants and sort values", () => {
  expect(ATTENDEES_PAGE_SIZE).toBe(100);
  expect(isAttendeeSort("newest")).toBe(true);
  expect(isAttendeeSort("oldest")).toBe(true);
  expect(isAttendeeSort("")).toBe(false);
  expect(LISTING_ATTENDEE_ROW_COLS).toContain("listing_attendees.listing_id");
});

describeWithEnv("attendee query helpers", { db: true }, () => {
  test("an empty listing filter returns an empty page", async () => {
    expect(
      await getAttendeesPage({ listingIds: [], page: 0, sort: "newest" }),
    ).toEqual({ hasNext: false, rows: [] });
  });

  test("returns only real lines from one package", async () => {
    const real = await createTestListing();
    const ghost = await createTestListing();
    const result = await createAttendeeAtomicImpl({
      allowOverbook: true,
      bookings: [
        { listingId: real.id, packageGroupId: 71, quantity: 1 },
        { listingId: ghost.id, packageGroupId: 71, quantity: 0 },
      ],
      email: "package@example.com",
      name: "Package",
    });
    if (!result.success) throw new Error("Expected attendee");

    expect(
      (await getAttendeePackageRowsRaw(result.attendees[0]!.id, 71)).map(
        (row) => row.listing_id,
      ),
    ).toEqual([real.id]);
  });

  test("resolves a booking ledger group to its attendee", async () => {
    const listing = await createTestListing();
    const { attendee } = await createTestAttendeeDirect(
      listing.id,
      "Ledger owner",
      "ledger-owner@example.com",
    );
    await getDb().execute({
      args: ["query-ledger-group", attendee.id],
      sql: "UPDATE listing_attendees SET ledger_event_group = ? WHERE attendee_id = ?",
    });

    expect(await attendeeIdByLedgerEventGroup("query-ledger-group")).toBe(
      attendee.id,
    );
    expect(await attendeeIdByLedgerEventGroup("missing-group")).toBeNull();
  });

  test("finds paid lines using every booking ledger key", async () => {
    const listing = await createTestListing();
    const { attendee } = await createTestAttendeeDirect(
      listing.id,
      "Paid",
      "paid-query@example.com",
    );
    await postListingSale({
      attendeeId: attendee.id,
      eventId: "query-paid",
      gross: 500,
      listingId: listing.id,
    });

    expect(await hasPaidLine(attendee.id, [listing.id])).toBe(true);
    expect(await hasPaidLine(attendee.id + 1, [listing.id])).toBe(false);
  });

  test("handles empty and populated bounded attendee lookups", async () => {
    const listing = await createTestListing();
    const { attendee } = await createTestAttendeeDirect(
      listing.id,
      "Bounded",
      "bounded@example.com",
    );

    expect(await getAttendeesByIds([])).toEqual([]);
    expect((await getAttendeesByIds([attendee.id]))[0]!.id).toBe(attendee.id);
    expect(await getAttendeeKindsByIds([])).toEqual(new Map());
    expect(await getAttendeeKindsByIds([attendee.id])).toEqual(
      new Map([[attendee.id, "attendee"]]),
    );
    expect(await getAttendeeNamesByIds([], await getTestPrivateKey())).toEqual(
      new Map(),
    );
    expect(
      await getAttendeeNamesByIds([attendee.id], await getTestPrivateKey()),
    ).toEqual(new Map([[attendee.id, "Bounded"]]));
  });
});
