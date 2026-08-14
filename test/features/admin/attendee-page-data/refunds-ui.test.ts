import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  buildCreateForm,
  buildEditFormFromAttendee,
  buildTemplateData,
  getRenderListings,
  type PackagePath,
  packagesByListingIdFrom,
} from "#routes/admin/attendee-page-data.ts";
import type { ExistingLine } from "#shared/db/attendees/atomic-update.ts";
import { createPaidListing } from "#test/features/admin/refunds-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import {
  createDailyTestListing,
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { testAttendee, testListingWithCount } from "#test-utils/factories.ts";

describeWithEnv("server (admin refund UI)", { db: true }, () => {
  describe("listing page UI", () => {
    const existingLine = (
      listingId: number,
      overrides: Partial<ExistingLine["booking"]> = {},
    ): ExistingLine => {
      const booking = {
        attachment_downloads: 0,
        checked_in: 0,
        end_at: null,
        ledger_event_group: "",
        listing_id: listingId,
        order_token: "",
        package_group_id: 0,
        parent_listing_id: 0,
        price_paid: 0,
        quantity: 1,
        refunded: 0,
        start_at: null,
        ...overrides,
      };
      return { booking, key: `${booking.listing_id}||0|0` };
    };

    test("groups package paths by listing and keeps zero-price overrides", () => {
      const paths: PackagePath[] = [
        {
          groupId: 10,
          memberListingIds: [1, 2],
          memberPrices: new Map([
            [1, 0],
            [2, 500],
          ]),
          packageName: "Starter bundle",
        },
        {
          groupId: 11,
          memberListingIds: [1],
          memberPrices: new Map(),
          packageName: "Second bundle",
        },
      ];

      const byListing = packagesByListingIdFrom(paths);

      expect(byListing).toEqual(
        new Map([
          [
            1,
            new Map([
              [10, 0],
              [11, null],
            ]),
          ],
          [2, new Map([[10, 500]])],
        ]),
      );
    });

    test("builds edit no-quantity lines and blank create lines", () => {
      const listing = testListingWithCount({ id: 1, name: "Line listing" });
      const unselected = testListingWithCount({
        id: 2,
        name: "Unselected listing",
      });
      const paths: PackagePath[] = [
        {
          groupId: 1,
          memberListingIds: [listing.id],
          memberPrices: new Map([[listing.id, 0]]),
          packageName: "Package line",
        },
      ];
      const attendee = testAttendee({
        address: "1 Test Street",
        email: "edit@example.com",
        listing_id: listing.id,
        name: "Edit User",
        phone: "07123456789",
        special_instructions: "Use side door",
        status_id: 7,
      });
      const edit = buildEditFormFromAttendee(
        attendee,
        [existingLine(listing.id, { quantity: 0 })],
        [listing],
        [],
      );
      const fallbackEdit = buildEditFormFromAttendee(
        testAttendee({
          address: "",
          email: "",
          listing_id: listing.id,
          phone: "",
          special_instructions: "",
        }),
        [],
        [listing],
        [],
      );
      const create = buildCreateForm(
        [listing, unselected],
        paths,
        new Map([[listing.id, 2]]),
        "",
      );
      const standalone = create.lines.find(
        (line) => line.listingId === listing.id && line.packageGroupId === 0,
      );
      const unselectedStandalone = create.lines.find(
        (line) => line.listingId === unselected.id && line.packageGroupId === 0,
      );
      const packaged = create.lines.find((line) => line.packageGroupId === 1);

      expect(edit.parsed.address).toBe(attendee.address);
      expect(edit.parsed.email).toBe(attendee.email);
      expect(edit.parsed.lines[0]?.noQuantity).toBe(true);
      expect(edit.parsed.name).toBe(attendee.name);
      expect(edit.parsed.phone).toBe(attendee.phone);
      expect(edit.parsed.returnUrl).toBe("");
      expect(edit.parsed.special_instructions).toBe(
        attendee.special_instructions,
      );
      expect(edit.parsed.statusId).toBe(attendee.status_id);
      expect(fallbackEdit.parsed.address).toBe("");
      expect(fallbackEdit.parsed.email).toBe("");
      expect(fallbackEdit.parsed.phone).toBe("");
      expect(fallbackEdit.parsed.special_instructions).toBe("");
      expect(standalone?.key).toBe("");
      expect(standalone?.noQuantity).toBe(false);
      expect(standalone?.parentListingId).toBe(0);
      expect(standalone?.quantity).toBe(2);
      expect(unselectedStandalone?.quantity).toBe(0);
      expect(packaged?.packagePrice).toBe(0);
      expect(packaged?.parentListingId).toBe(0);
      expect(packaged?.quantity).toBe(0);
      expect(create.address).toBe("");
      expect(create.dayCount).toBe(1);
      expect(create.email).toBe("");
      expect(create.name).toBe("");
      expect(create.phone).toBe("");
      expect(create.returnUrl).toBe("");
      expect(create.special_instructions).toBe("");
      expect(create.startDate).toBe("");
      expect(create.statusId).toBe(null);
    });

    test("builds duration warnings only for over-duration daily lines", async () => {
      const daily = await createDailyTestListing({
        durationDays: 1,
        name: "Daily warning listing",
      });
      const standard = await createTestListing({
        durationDays: 1,
        name: "Standard no warning listing",
      });
      const dailyParsed = buildCreateForm(
        [testListingWithCount(daily)],
        [],
        new Map([[daily.id, 1]]),
        "2026-08-01",
      );
      const standardParsed = buildCreateForm(
        [testListingWithCount(standard)],
        [],
        new Map([[standard.id, 1]]),
        "2026-08-01",
      );
      dailyParsed.dayCount = 2;
      standardParsed.dayCount = 2;

      const dailyData = await buildTemplateData("create", dailyParsed, null);
      const standardData = await buildTemplateData(
        "create",
        standardParsed,
        null,
      );

      expect(dailyData.topWarnings[0]).toContain(daily.name);
      expect(standardData.topWarnings).toEqual([]);
    });

    test("builds daily overbook warnings with date-aware spans", async () => {
      const nextDateDaily = await createDailyTestListing({
        maxAttendees: 1,
        name: "Next date daily",
      });
      await bookAttendee(nextDateDaily, {
        date: "2026-08-01",
        email: "first-next-date@example.com",
        name: "First next date",
      });
      const nextDateParsed = buildCreateForm(
        [testListingWithCount(nextDateDaily)],
        [],
        new Map([[nextDateDaily.id, 1]]),
        "2026-08-02",
      );
      const noDateDaily = await createDailyTestListing({
        maxAttendees: 1,
        name: "No date daily",
      });
      await bookAttendee(noDateDaily, {
        date: "2026-08-01",
        email: "first-no-date@example.com",
        name: "First no date",
      });
      const noDateParsed = buildCreateForm(
        [testListingWithCount(noDateDaily)],
        [],
        new Map([[noDateDaily.id, 1]]),
        "",
      );

      const spanDaily = await createDailyTestListing({
        durationDays: 2,
        maxAttendees: 1,
        name: "Span daily",
      });
      await bookAttendee(spanDaily, {
        date: "2026-08-03",
        email: "first-span@example.com",
        name: "First span",
      });
      const spanParsed = buildCreateForm(
        [testListingWithCount(spanDaily)],
        [],
        new Map([[spanDaily.id, 1]]),
        "2026-08-02",
      );
      spanParsed.dayCount = 2;

      const nextDateData = await buildTemplateData(
        "create",
        nextDateParsed,
        null,
      );
      const noDateData = await buildTemplateData("create", noDateParsed, null);
      const spanData = await buildTemplateData("create", spanParsed, null);

      expect(nextDateData.topWarnings).toEqual([]);
      expect(noDateData.topWarnings).toEqual([]);
      expect(spanData.topWarnings[0]).toContain(spanDaily.name);
    });

    test("renders active listings plus inactive listings the attendee already books", async () => {
      const active = await createPaidListing({ name: "Active listing" });
      const inactiveBooked = await createPaidListing({
        name: "Inactive booked listing",
      });
      const inactiveUnbooked = await createPaidListing({
        name: "Inactive unbooked listing",
      });
      await deactivateTestListing(inactiveBooked.id);
      await deactivateTestListing(inactiveUnbooked.id);
      const existing = [existingLine(inactiveBooked.id)];

      const names = (await getRenderListings(existing)).map(
        (listing) => listing.name,
      );

      expect(names).toContain(active.name);
      expect(names).toContain(inactiveBooked.name);
      expect(names).not.toContain(inactiveUnbooked.name);
    });
  });
});
