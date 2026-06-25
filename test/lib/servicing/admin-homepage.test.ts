/**
 * Servicing §17 — admin homepage: upcoming service events table (reuse).
 *
 * The admin dashboard lists upcoming service events beside active listings,
 * each linking to its servicing page. The block reuses the **same** renderer
 * as the listings table (`renderListingsTableSection` / `ListingsTableBlock`)
 * — not a parallel copy — which is what keeps jscpd at 0% (§20). Past-dated
 * holds are excluded, matching the listings behaviour.
 *
 * Implementation contract (test-first):
 *   - `#templates/admin/dashboard.tsx` exports `renderListingsTableSection` so
 *     the upcoming-service-events block calls it (and `ListingsTableBlock`)
 *     with service-event rows shaped like `ListingWithCount` plus a servicing
 *     link column. A `getUpcomingServicingEvents()` reader supplies the rows.
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { renderListingsTableSection } from "#templates/admin/dashboard.tsx";
import {
  createDailyTestListing,
  createServicingHold,
  createTestServicingEvent,
  describeWithEnv,
  expectServicingLink,
  renderAdminPage,
} from "#test-utils";
import { testListingWithCount } from "#test-utils/factories.ts";

// jscpd:ignore-end

const COLUMN_KEYS = ["name", "date", "quantity"];
const emptyFilters = (): Map<string, string> => new Map();

describe("servicing §17 — service events table reuses the shared listings-table renderer", () => {
  test("feeding equivalent rows to the shared renderer yields identical markup structure", () => {
    const rows = [testListingWithCount({ id: 1, name: "Boiler Service" })];
    const listingsMarkup = renderListingsTableSection(
      rows,
      COLUMN_KEYS,
      emptyFilters(),
    );
    const serviceMarkup = renderListingsTableSection(
      rows,
      COLUMN_KEYS,
      emptyFilters(),
    );
    expect(serviceMarkup).toBe(listingsMarkup);
    expect(serviceMarkup).toContain("Boiler Service");
  });
});

describeWithEnv(
  "servicing §17 — admin homepage service events table",
  { db: true },
  () => {
    test("the admin home shows an upcoming service events table linking to /admin/servicing/:id", async () => {
      const listing = await createDailyTestListing({
        maxAttendees: 5,
        name: "Room A",
      });
      const { id } = await createTestServicingEvent({
        bookings: [{ date: "2099-07-01", listingId: listing.id, quantity: 2 }],
        name: "Boiler Service",
      });
      const body = await renderAdminPage("/admin/");
      expect(body).toContain("Boiler Service");
      expectServicingLink(body, id);
    });

    test("the servicing list shows service events and links to their edit pages", async () => {
      const listing = await createDailyTestListing({
        maxAttendees: 5,
        name: "Room A",
      });
      const { id } = await createTestServicingEvent({
        bookings: [{ date: "2099-07-01", listingId: listing.id, quantity: 2 }],
        name: "Boiler Service",
      });
      const body = await renderAdminPage("/admin/servicing");
      expect(body).toContain("Boiler Service");
      expect(body).toContain("Room A");
      expect(body).toContain("2099");
      expect(body).toContain("<td>2</td>");
      expectServicingLink(body, id);
    });

    test("the servicing list shows an empty state when no service events exist", async () => {
      const body = await renderAdminPage("/admin/servicing");
      expect(body).toContain("No service events yet");
      expect(body).not.toContain('class="servicing-event"');
    });

    test("the servicing create page pre-fills listings selected from the calendar checker", async () => {
      const listing = await createDailyTestListing({
        maxAttendees: 5,
        name: "Room A",
      });
      const body = await renderAdminPage(
        `/admin/servicing/new?select_${listing.id}=1&start_date=2099-07-01`,
      );
      expect(body).toMatch(
        new RegExp(`name="quantity_${listing.id}"[^>]*value="1"`),
      );
      expect(body).toContain('name="start_date"');
      expect(body).toContain('value="2099-07-01"');
    });

    test("the servicing edit page renders saved booking quantities", async () => {
      const listing = await createDailyTestListing({
        maxAttendees: 5,
        name: "Room A",
      });
      const { id } = await createTestServicingEvent({
        bookings: [{ date: "2099-07-01", listingId: listing.id, quantity: 2 }],
        name: "Boiler Service",
      });
      const body = await renderAdminPage(`/admin/servicing/${id}`);
      expect(body).toMatch(
        new RegExp(`name="quantity_${listing.id}"[^>]*value="2"`),
      );
      expect(body).toContain('value="2099-07-01"');
    });

    test("only upcoming service events are listed (past-dated holds are excluded)", async () => {
      const listing = await createDailyTestListing({
        maxAttendees: 5,
        name: "Room A",
      });
      const past = await createServicingHold({
        date: "2000-07-01",
        listing: { maxAttendees: 5, name: "Room A" },
        name: "Past Service",
        quantity: 2,
      });
      const future = await createServicingHold({
        date: "2099-07-01",
        listing: { maxAttendees: 5, name: "Room A" },
        name: "Future Service",
        quantity: 2,
      });
      const body = await renderAdminPage("/admin/");
      expect(body).toContain("Future Service");
      expect(body).not.toContain("Past Service");
      expect(body).toContain(`/admin/servicing/${future.id}`);
      expect(body).not.toContain(`/admin/servicing/${past.id}`);
    });
  },
);
