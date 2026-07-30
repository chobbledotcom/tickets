// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { leaveEvidencePage } from "#scripts/specs/evidence/pages.ts";
import { getListingRemainingForRange } from "#shared/db/attendees/capacity/remaining.ts";
import { submitRenderedAdminForm } from "#test/specs/support/browser.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import {
  createServicingEvent,
  renderAdminPage,
} from "#test-utils/servicing.ts";
import { enablePublicSite } from "#test-utils/settings.ts";

// jscpd:ignore-end

const ROOM_A = "Room A";
const ANNUAL_ROOM = "Annual Room";
const BOILER_SERVICE = "Boiler Service";
const ANNUAL_INSPECTION = "Annual Inspection";
const STUDIO_LISTING = "Ceramics Studio Sessions";
const STUDIO_HOLD = "Studio floor treatment";
const STUDIO_HOLD_DATE = "2099-07-06";

const createHoldViaProduction = async (
  world: TicketsWorld,
  listingName: string,
  holdName: string,
  listingOverrides: Record<string, string | number> = {},
): Promise<{ eventId: number; listingId: number }> => {
  const listing = await createTestListing({
    durationDays: 1,
    listingType: "daily",
    maxAttendees: 5,
    maximumDaysAfter: 365,
    maxQuantity: 5,
    name: listingName,
    ...listingOverrides,
  });
  const event = await createServicingEvent({
    bookings: [{ date: "2099-07-01", listingId: listing.id, quantity: 1 }],
    name: holdName,
  });
  world.servicingEventId = event.id;
  world.holdListingId = listing.id;
  return { eventId: event.id, listingId: listing.id };
};

Given(
  "an organiser has created a Boiler Service hold on Room A",
  async function (this: TicketsWorld): Promise<void> {
    await createHoldViaProduction(this, ROOM_A, BOILER_SERVICE, {
      maxAttendees: 1,
    });
  },
);

Given(
  "Ceramics Studio Sessions is available for service work",
  async function (this: TicketsWorld): Promise<void> {
    const listing = await createTestListing({
      bookableDays: ["Monday", "Tuesday"],
      durationDays: 1,
      listingType: "daily",
      location: "Kiln Yard Studios",
      maxAttendees: 16,
      maximumDaysAfter: 50_000,
      maxQuantity: 8,
      minimumDaysBefore: 0,
      name: STUDIO_LISTING,
      unitPrice: 2_800,
    });
    this.holdListingId = listing.id;
    this.listingIds.set(STUDIO_LISTING, listing.id);
  },
);

When(
  "the organiser creates a two-day Studio floor treatment hold for four places",
  async function (this: TicketsWorld): Promise<void> {
    const listingId = requiredWorldValue(
      this.listingIds.get(STUDIO_LISTING),
      "studio listing id",
    );
    const browser = await submitRenderedAdminForm(
      this,
      "/admin/servicing/new",
      "Create Service Event",
      {
        day_count: "2",
        name: STUDIO_HOLD,
        [`quantity_${listingId}`]: "4",
        start_date: STUDIO_HOLD_DATE,
      },
    );
    const match = browser.currentUrl.match(/^\/admin\/servicing\/(\d+)$/);
    if (!match) {
      throw new Error("Creating the service hold did not open its edit page");
    }
    const eventId = Number(requiredWorldValue(match[1], "service event id"));
    this.servicingEventId = eventId;
    leaveEvidencePage(
      this,
      ["servicing-studio-floor-hold"],
      `/admin/servicing/${eventId}`,
    );
  },
);

Given(
  "an organiser has created an Annual Inspection hold on Annual Room",
  async function (this: TicketsWorld): Promise<void> {
    await createHoldViaProduction(this, ANNUAL_ROOM, ANNUAL_INSPECTION, {
      maxAttendees: 10,
      maximumDaysAfter: 1000,
    });
  },
);

When(
  "the organiser duplicates the service event",
  async function (this: TicketsWorld): Promise<void> {
    const id = requiredWorldValue(this.servicingEventId, "service event id");
    await submitRenderedAdminForm(this, `/admin/servicing/${id}`, "Duplicate");
  },
);

When(
  "the organiser deletes the service event",
  async function (this: TicketsWorld): Promise<void> {
    const id = requiredWorldValue(this.servicingEventId, "service event id");
    await submitRenderedAdminForm(
      this,
      `/admin/servicing/${id}`,
      "Delete Service Event",
    );
  },
);

When(
  "the organiser records a cost of 90.00 for Boiler Service",
  async function (this: TicketsWorld): Promise<void> {
    const id = requiredWorldValue(this.servicingEventId, "service event id");
    const browser = await submitRenderedAdminForm(
      this,
      `/admin/servicing/${id}`,
      "Record service event cost",
      {
        amount: "90.00",
        memo: "Boiler part",
      },
    );
    expect(browser.currentUrl).toBe(`/admin/servicing/${id}`);
  },
);

Then(
  "the admin dashboard shows the Studio floor treatment hold",
  async function (this: TicketsWorld): Promise<void> {
    const body = await renderAdminPage("/admin/");
    expect(body).toContain(STUDIO_HOLD);
  },
);

Then(
  "the admin dashboard shows two Annual Inspection holds",
  async function (this: TicketsWorld): Promise<void> {
    const body = await renderAdminPage("/admin/");
    const count = (body.match(/Annual Inspection/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  },
);

Then(
  "the public site does not show Studio floor treatment",
  async function (this: TicketsWorld): Promise<void> {
    await enablePublicSite();
    const response = await awaitTestRequest("/");
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(STUDIO_HOLD);
  },
);

Then(
  "the admin dashboard no longer shows Boiler Service",
  async function (this: TicketsWorld): Promise<void> {
    const body = await renderAdminPage("/admin/");
    expect(body).not.toContain(BOILER_SERVICE);
  },
);

Then(
  "the service event page shows the recorded cost",
  async function (this: TicketsWorld): Promise<void> {
    const id = requiredWorldValue(this.servicingEventId, "service event id");
    const body = await renderAdminPage(`/admin/servicing/${id}`);
    expect(body).toContain(">£90<");
    expect(body).toContain("Boiler part");
  },
);

Then(
  "the held listing has its full capacity restored",
  async function (this: TicketsWorld): Promise<void> {
    const listingId = requiredWorldValue(this.holdListingId, "hold listing id");
    expect(await getListingRemainingForRange(listingId, "2099-07-01")).toBe(1);
  },
);
