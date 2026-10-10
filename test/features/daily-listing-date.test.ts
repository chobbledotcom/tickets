/** Issue #2240: while a listing is daily, its stored `date` carries no fact —
 * the attendee picks a date per booking — so every reader treats it as empty at
 * read time. The stored row keeps the date, so switching the type back to
 * standard brings it back on every surface. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeePiiBlobsForListings } from "#db/attendees/pii.ts";
import { getListingsNotInGroup } from "#db/groups/candidates.ts";
import {
  getAllListings,
  getListingWithCount,
  getStoredListingWithCount,
} from "#db/listings/records.ts";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { getListingAndGroups } from "#routes/admin/listing-page-data.ts";
import { audienceSpec } from "#shared/bulk-email-targets/audience.ts";
import { sendRegistrationEmails } from "#shared/email/registration.ts";
import { dimensionsOf } from "#shared/listing-templates.ts";
import { loadSortedListings } from "#shared/sort-listings.ts";
import { columnOrThrow } from "#shared/tables/definition.ts";
import { listingTable } from "#templates/admin/listing-table.tsx";
import { listingToFieldValues } from "#templates/admin/listings/form-values.tsx";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createTestListing,
  updateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import {
  configureTestEmail,
  expectSingleTicketSvg,
} from "#test-utils/email.ts";
import { makeTestAttendee } from "#test-utils/factories.ts";
import { useFetchStub } from "#test-utils/mocks.ts";
import { adminGet, apiRequest } from "#test-utils/session.ts";
import { enablePublicSite } from "#test-utils/settings.ts";

/** The date an owner set while the listing was standard, left stored after the
 * type changed to daily. Form precision; the row stores the UTC instant. */
const STORED_DATE = "2020-06-15T18:00";

/** Every spelling the surfaces can leak the stored date in: ISO (details link,
 * API, CSV created column of a same-dated row), ICS, and the British label
 * forms the templates render in the Europe/London test timezone. */
const DATE_TOKENS = [
  "2020-06-15",
  "20200615",
  "15 June 2020",
  "15 Jun 2020",
  "15/06/2020",
];

/** A daily listing still carrying the date its standard days set. */
const dailyListingWithStoredDate = async () =>
  createTestListing({ date: STORED_DATE, listingType: "daily" });

/** One render or export surface: given the listing id, produce everything the
 * surface sends to a reader. */
type Surface = {
  name: string;
  rendered: (listingId: number) => Promise<string>;
};

describeWithEnv(
  "daily listing hides its stored date",
  { db: true, triggers: true },
  () => {
    const fetch = useFetchStub();

    const SURFACES: Surface[] = [
      {
        name: "admin details tab",
        rendered: async (id) =>
          await (await adminGet(`/admin/listing/${id}`)).text(),
      },
      {
        name: "admin listings table",
        // The dashboard's default layout omits the date column; the operator
        // can add it, so render the real column cell over the real read.
        rendered: async (id) => {
          const listings = await getAllListings();
          const row = listings.find((entry) => entry.id === id)!;
          return String(
            columnOrThrow(listingTable, "date").cell(row, undefined, 0, [row]),
          );
        },
      },
      {
        name: "listings CSV export",
        rendered: async () =>
          await (await adminGet("/admin/listings/csv")).text(),
      },
      {
        name: "edit form pre-fill",
        rendered: async (id) =>
          String(
            listingToFieldValues((await getListingAndGroups(id))!.listing)
              .date ?? "",
          ),
      },
      {
        name: "public homepage",
        rendered: async () => {
          await enablePublicSite();
          const response = await handleRequest(
            new Request("http://localhost/listings"),
          );
          return await response.text();
        },
      },
      {
        name: "feeds",
        rendered: async () => {
          await enablePublicSite();
          await settings.update.calendarFeedsEnabled(true);
          const ics = await handleRequest(
            new Request("http://localhost/feeds/listings.ics"),
          );
          const rss = await handleRequest(
            new Request("http://localhost/feeds/listings.rss"),
          );
          return `${await ics.text()}\n${await rss.text()}`;
        },
      },
      {
        name: "registration email",
        rendered: async (id) => {
          await configureTestEmail();
          await sendRegistrationEmails(
            [
              {
                attendee: makeTestAttendee(),
                listing: (await getListingWithCount(id))!,
              },
            ],
            "GBP",
          );
          const body = fetch.getFetchJsonBody();
          const svg = expectSingleTicketSvg(body);
          return `${body.html}\n${svg}`;
        },
      },
    ];

    for (const surface of SURFACES) {
      test(`the ${surface.name} shows no listing date`, async () => {
        const listing = await dailyListingWithStoredDate();
        const rendered = await surface.rendered(listing.id);
        for (const token of DATE_TOKENS) {
          expect(rendered, surface.name).not.toContain(token);
        }
      });
    }

    test("the public API reports no date", async () => {
      const listing = await dailyListingWithStoredDate();
      await settings.update.showPublicApi(true);
      const response = await handleRequest(
        new Request("http://localhost/api/listings"),
      );
      const body = await response.json();
      const publicListing = body.listings.find(
        (entry: { slug: string }) => entry.slug === listing.slug,
      );
      expect(publicListing.date).toBeNull();
    });

    test("the sort keys read an empty date", async () => {
      const listing = await dailyListingWithStoredDate();
      const { listings } = await loadSortedListings();
      const sorted = listings.find((entry) => entry.id === listing.id)!;
      expect(sorted.date).toBe("");
    });

    test("the upcoming bulk-email audience still covers a daily listing whose stored date has passed", async () => {
      const listing = await dailyListingWithStoredDate();
      await createTestAttendeeDirect(
        listing.id,
        "Jane Doe",
        "jane@example.com",
      );
      const blobs = await audienceSpec.loadPiiBlobs(
        { audience: "upcoming", kind: "audience" },
        Date.now(),
      );
      const ownBlobs = await getAttendeePiiBlobsForListings([listing.id]);
      expect(blobs).toContain(ownBlobs[0]);
    });

    test("the derived dated fact is false while the listing is daily", async () => {
      const listing = await dailyListingWithStoredDate();
      const effective = (await getListingWithCount(listing.id))!;
      expect(dimensionsOf(effective).dated).toBe(false);
    });

    test("the effective read empties the date and the stored read keeps it", async () => {
      const listing = await dailyListingWithStoredDate();
      expect((await getListingWithCount(listing.id))!.date).toBe("");
      expect((await getStoredListingWithCount(listing.id))!.date).toBe(
        "2020-06-15T18:00:00.000Z",
      );
    });

    test("the narrow group-candidate read empties the date", async () => {
      const listing = await dailyListingWithStoredDate();
      const group = await createTestGroup({ name: "Candidates" });
      const candidates = await getListingsNotInGroup(group.id);
      expect(candidates.find((row) => row.id === listing.id)!.date).toBe("");
    });

    test("saving a daily listing with an empty date keeps the stored date", async () => {
      const listing = await createTestListing({ date: STORED_DATE });
      await updateTestListing(listing.id, { date: "", listingType: "daily" });
      expect((await getStoredListingWithCount(listing.id))!.date).toBe(
        "2020-06-15T18:00:00.000Z",
      );
    });

    test("saving a daily listing with a typed date writes it", async () => {
      const listing = await dailyListingWithStoredDate();
      await updateTestListing(listing.id, { date: "2021-01-01T10:00" });
      expect((await getStoredListingWithCount(listing.id))!.date).toBe(
        "2021-01-01T10:00:00.000Z",
      );
    });

    test("a standard listing still clears its date", async () => {
      const listing = await createTestListing({ date: STORED_DATE });
      await updateTestListing(listing.id, { date: "" });
      expect((await getStoredListingWithCount(listing.id))!.date).toBe("");
    });

    /** PUT a body to the admin API row and return the stored date the write
     * left behind. */
    const storedDateAfterApiPut = async (
      listing: { id: number; name: string },
      body: Record<string, unknown>,
    ): Promise<string> => {
      const response = await apiRequest(`/api/admin/listings/${listing.id}`, {
        body,
        method: "PUT",
      });
      expect(response.status).toBe(200);
      return (await getStoredListingWithCount(listing.id))!.date;
    };

    test("the admin API keeps the stored date on an empty-date update of a daily listing", async () => {
      const listing = await dailyListingWithStoredDate();
      expect(await storedDateAfterApiPut(listing, { date: "" })).toBe(
        "2020-06-15T18:00:00.000Z",
      );
    });

    test("the admin API keeps the stored date when an update omits it", async () => {
      const listing = await dailyListingWithStoredDate();
      expect(await storedDateAfterApiPut(listing, { name: listing.name })).toBe(
        "2020-06-15T18:00:00.000Z",
      );
    });

    test("switching the type back to standard restores the date on every reader", async () => {
      const listing = await createTestListing({ date: STORED_DATE });
      await updateTestListing(listing.id, { date: "", listingType: "daily" });
      await updateTestListing(listing.id, {
        date: "",
        listingType: "standard",
      });
      expect((await getListingWithCount(listing.id))!.date).toBe(
        "2020-06-15T18:00:00.000Z",
      );
      await settings.update.showPublicApi(true);
      const response = await handleRequest(
        new Request(`http://localhost/api/listings/${listing.slug}`),
      );
      const body = await response.json();
      expect(body.listing.date).toBe("2020-06-15T18:00:00.000Z");
    });
  },
);
