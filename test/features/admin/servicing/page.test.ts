// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { SERVICING_KIND } from "#db/attendees/kind.ts";
import {
  listingsForServicingEdit,
  renderServicingList,
  renderServicingPage,
} from "#routes/admin/servicing/page.tsx";
import { formatCurrency } from "#shared/currency.ts";
import { formatDateLabel } from "#shared/dates.ts";
import { servicingEventDateLabel } from "#templates/admin/servicing-events.tsx";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { testListingWithCount } from "#test-utils/factories.ts";
import {
  createServicingEvent,
  recordServiceCost,
  renderAdminPage,
  updateServicingEvent,
} from "#test-utils/servicing.ts";

// jscpd:ignore-end

const testSession = (adminLevel: "owner" | "editor" = "owner") => ({
  adminLevel,
  token: "test-token",
  userId: 1,
  wrappedDataKey: null,
});

describeWithEnv("servicing cost page", { db: true }, () => {
  test("keeps an inactive former hold's name and exact owner Money link", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      name: "Old boiler room",
    });
    const remaining = await createTestListing({
      maxAttendees: 10,
      name: "Main hall",
    });
    const event = await createServicingEvent({
      bookings: [
        { listingId: listing.id, quantity: 1 },
        { listingId: remaining.id, quantity: 1 },
      ],
      name: "Annual service",
    });
    await recordServiceCost({
      amount: 9000,
      listingId: listing.id,
      memo: "Boiler part",
      occurredAt: "2026-07-01T00:00:00.000Z",
      servicingId: event.id,
    });
    await updateServicingEvent(event.id, {
      bookings: [{ listingId: remaining.id, quantity: 1 }],
      name: event.name,
    });
    await deactivateTestListing(listing.id);

    const body = await renderAdminPage(`/admin/servicing/${event.id}`);

    expect(body).toContain(listing.name);
    expect(body).toContain(
      `href="/admin/ledger?listing=${listing.id}">${listing.name}</a>`,
    );
    // An event page lives within the Servicing section: the section's own
    // link lights up, and its "Add" sub-item does not.
    expect(body).toContain('<a class="active" href="/admin/servicing">');
    expect(body).not.toContain(
      '<a class="active" href="/admin/servicing/new">',
    );

    // The list page is the section's landing route, so it lights up too.
    const listPage = await renderAdminPage("/admin/servicing");
    expect(listPage).toContain('<a class="active" href="/admin/servicing">');

    // The new-event page is the "Add" sub-item's own route.
    const newPage = await renderAdminPage("/admin/servicing/new");
    expect(newPage).toContain('<a class="active" href="/admin/servicing/new">');
  });

  test("hides cost controls when no listing can receive the cost", () => {
    const body = renderServicingPage({
      event: {
        bookings: [],
        id: 1,
        kind: SERVICING_KIND,
        name: "Finished service",
        ticketToken: "test-token",
      },
      listings: [],
      session: testSession(),
    });

    expect(body).not.toContain('name="target_listing_id"');
    expect(body).not.toContain("Record service event cost");
  });

  test("keeps only held inactive listings and reports deleted holds", () => {
    const active = testListingWithCount({
      id: 1,
      name: "Main hall",
    });
    const unheldInactive = testListingWithCount({
      active: false,
      id: 2,
      name: "Storage room",
    });
    const heldInactive = testListingWithCount({
      active: false,
      id: 3,
      name: "Old boiler room",
    });

    const result = listingsForServicingEdit(
      [active, unheldInactive, heldInactive],
      {
        bookings: [
          { listingId: 1, quantity: 1 },
          { listingId: 3, quantity: 1 },
          { listingId: 9, quantity: 1 },
        ],
        id: 7,
        kind: SERVICING_KIND,
        name: "Service",
        ticketToken: "tok",
      },
    );

    expect(result.deletedHolds).toEqual([9]);
    expect(result.listings.map((listing) => listing.id)).toEqual([1, 3]);
  });

  test("renders the new event page with the create form", () => {
    const listings = [testListingWithCount({ id: 3, name: "Main hall" })];
    const body = renderServicingPage({
      event: null,
      listings,
      session: testSession(),
    });

    expect(body).toContain("<h1>New service event</h1>");
    expect(body).toContain('action="/admin/servicing/new"');
    expect(body).toContain('id="servicing-form"');
    expect(body).toContain("Create service event");
    expect(body).toContain(
      '<input autocomplete="off" maxlength="500" name="name" required type="text">',
    );
    expect(body).toContain('<input name="start_date" type="date">');
    expect(body).toContain(
      '<input min="1" name="day_count" type="number" value="1">',
    );
    expect(body).toContain('<use href="/icons.svg#plus">');
    expect(body).toContain(
      '<input min="0" name="quantity_3" type="number" value="0">',
    );
    // No stored event yet, so none of the event-only sections render.
    expect(body).not.toContain('class="warning"');
    expect(body).not.toContain("Annual service");
  });

  test("renders an event page with every editing section", () => {
    const body = renderServicingPage({
      costListingNames: new Map([[3, "Main hall"]]),
      costs: [
        {
          amount: 9000,
          date: "2026-07-01T00:00:00.000Z",
          id: 44,
          listingId: 3,
          memo: "Boiler part",
        },
      ],
      deletedHolds: [12],
      event: {
        bookings: [
          {
            date: "2026-07-01",
            durationDays: 2,
            listingId: 3,
            quantity: 2,
          },
        ],
        id: 7,
        kind: SERVICING_KIND,
        name: "Annual service",
        ticketToken: "tok",
      },
      listings: [
        testListingWithCount({ id: 3, name: "Main hall" }),
        testListingWithCount({ active: false, id: 4, name: "Storage room" }),
      ],
      session: testSession(),
    });

    expect(body).toContain("<h1>Annual service</h1>");
    expect(body).toContain('action="/admin/servicing/7"');
    expect(body).toContain(
      '<p class="warning">1 held listing no longer exists.',
    );
    expect(body).toContain(
      'name="name" required type="text" value="Annual service"',
    );
    expect(body).toContain('name="start_date" type="date" value="2026-07-01"');
    expect(body).toContain('<use href="/icons.svg#save">');
    expect(body).toContain("<td>Main hall</td>");
    expect(body).toContain("<td>Storage room<em> (inactive)</em></td>");
    expect(body).toContain(
      '<input min="0" name="quantity_3" type="number" value="2">',
    );
    expect(body).toContain("Save service event");
    expect(body).not.toContain("Create service event");
    expect(body).toContain('action="/admin/servicing/7/duplicate"');
    expect(body).toContain('action="/admin/servicing/7/delete"');
    expect(body).toContain("Record service event cost");
    expect(body).toContain('name="cost_idempotency_key" type="hidden"');
    expect(body).toContain('name="amount"');
    expect(body).toContain('name="memo"');
    expect(body).toContain('name="target_listing_id"');
    expect(body).toContain("Service event costs");
    expect(body).toContain("Boiler part");
  });

  const renderCostsPage = (adminLevel: "owner" | "editor"): string =>
    renderServicingPage({
      costListingNames: new Map([[3, "Main hall"]]),
      costs: [
        {
          amount: 9000,
          date: "2026-07-01T00:00:00.000Z",
          id: 44,
          listingId: 3,
          memo: "Boiler part",
        },
        {
          amount: 250,
          date: "2026-07-02T00:00:00.000Z",
          id: 45,
          listingId: 99,
          memo: "Spare keys",
        },
      ],
      event: {
        bookings: [{ listingId: 3, quantity: 1 }],
        id: 7,
        kind: SERVICING_KIND,
        name: "Annual service",
        ticketToken: "tok",
      },
      listings: [testListingWithCount({ id: 3, name: "Main hall" })],
      session: testSession(adminLevel),
    });

  test("renders the costs table with its date, note, and money links", () => {
    const ownerBody = renderCostsPage("owner");

    expect(ownerBody).toContain('href="/admin/ledger?listing=3">Main hall</a>');
    expect(ownerBody).toContain("Deleted listing");
    expect(ownerBody).toContain(`<td>${formatDateLabel("2026-07-01")}</td>`);
    expect(ownerBody).toContain(`<td>${formatDateLabel("2026-07-02")}</td>`);
    expect(ownerBody).toContain(
      `<td class="col-amount">${formatCurrency(9000)}</td>`,
    );
    expect(ownerBody).toContain(
      `<td class="col-amount">${formatCurrency(250)}</td>`,
    );
    expect(ownerBody).toContain('id="servicing-costs"');
    expect(ownerBody).toContain('class="listing-section"');
    expect(ownerBody).toContain('class="danger"');
    // One amount input in the record-cost form, one in each cost row editor.
    expect(ownerBody.match(/name="amount"/g)).toHaveLength(3);
  });

  test("keeps the cost table's money link owner-only", () => {
    const editorBody = renderCostsPage("editor");

    // The editor still sees the listing name, but the owner-only money link
    // stays off their table.
    expect(editorBody).toContain("Main hall");
    expect(editorBody).not.toContain("/admin/ledger?listing=");
  });

  test("renders the servicing list's rows, deleted listings, and empty state", () => {
    const list = renderServicingList(
      testSession(),
      [
        {
          bookings: [
            { listingId: 3, quantity: 2 },
            { listingId: 4, quantity: 1 },
            { listingId: 9, quantity: 1 },
          ],
          date: "2026-07-01",
          id: 7,
          name: "Annual service",
          totalQuantity: 4,
        },
      ],
      [
        testListingWithCount({ id: 3, name: "Main hall" }),
        testListingWithCount({ id: 4, name: "Storage room" }),
      ],
    );

    expect(list).toContain(
      '<tr class="servicing-event" data-servicing="true">',
    );
    expect(list).toContain("Annual service");
    expect(list).toContain('href="/admin/servicing/7"');
    expect(list).toContain(`<td>${servicingEventDateLabel("2026-07-01")}</td>`);
    expect(list).toContain("<td>Main hall, Storage room, Deleted listing</td>");
    expect(list).toContain(
      "<th>Name</th><th>Date</th><th>Listings</th><th>Quantity</th>",
    );
    expect(list).toContain("<td>4</td>");
    expect(list).toContain('href="/admin/guide#servicing"');
    expect(list).toContain("Servicing guide");

    const emptyList = renderServicingList(testSession(), [], []);
    expect(emptyList).toContain("No service events yet.");
  });
});
