// jscpd:ignore-start

import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { SERVICING_KIND } from "#db/attendees/kind.ts";
import {
  listingsForServicingEdit,
  renderServicingList,
  renderServicingPage,
} from "#routes/admin/servicing/page.tsx";
import { formatCurrency } from "#shared/currency.ts";
import { formatDateLabel } from "#shared/date-labels.ts";
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

    assertStringIncludes(body, listing.name);
    assertStringIncludes(
      body,
      `href="/admin/ledger?listing=${listing.id}">${listing.name}</a>`,
    );
    // An event page lives within the Servicing section: the section's own
    // link lights up, and its "Add" sub-item does not.
    assertStringIncludes(body, '<a class="active" href="/admin/servicing">');
    assert(
      !body.includes('<a class="active" href="/admin/servicing/new">'),
      "the value should not contain the searched item",
    );

    // The list page is the section's landing route, so it lights up too.
    const listPage = await renderAdminPage("/admin/servicing");
    assertStringIncludes(
      listPage,
      '<a class="active" href="/admin/servicing">',
    );

    // The new-event page is the "Add" sub-item's own route.
    const newPage = await renderAdminPage("/admin/servicing/new");
    assertStringIncludes(
      newPage,
      '<a class="active" href="/admin/servicing/new">',
    );
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

    assert(
      !body.includes('name="target_listing_id"'),
      "the value should not contain the searched item",
    );
    assert(
      !body.includes("Record service event cost"),
      "the value should not contain the searched item",
    );
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

    assertStringIncludes(body, "<h1>New service event</h1>");
    assertStringIncludes(body, 'action="/admin/servicing/new"');
    assertStringIncludes(body, 'id="servicing-form"');
    assertStringIncludes(body, "Create service event");
    assertStringIncludes(
      body,
      '<input autocomplete="off" maxlength="250" name="name" required type="text">',
    );
    assertStringIncludes(body, '<input name="start_date" type="date">');
    assertStringIncludes(
      body,
      '<input min="1" name="day_count" type="number" value="1">',
    );
    assertStringIncludes(body, '<use href="/icons.svg#plus">');
    assertStringIncludes(
      body,
      '<input min="0" name="quantity_3" type="number" value="0">',
    );
    // No stored event yet, so none of the event-only sections render.
    assert(
      !body.includes('class="warning"'),
      "the value should not contain the searched item",
    );
    assert(
      !body.includes("Annual service"),
      "the value should not contain the searched item",
    );
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

    assertStringIncludes(body, "<h1>Annual service</h1>");
    assertStringIncludes(body, 'action="/admin/servicing/7"');
    assertStringIncludes(
      body,
      '<p class="warning">1 held listing no longer exists.',
    );
    assertStringIncludes(
      body,
      'name="name" required type="text" value="Annual service"',
    );
    assertStringIncludes(
      body,
      'name="start_date" type="date" value="2026-07-01"',
    );
    assertStringIncludes(body, '<use href="/icons.svg#save">');
    assertStringIncludes(body, "<td>Main hall</td>");
    assertStringIncludes(body, "<td>Storage room<em> (inactive)</em></td>");
    assertStringIncludes(
      body,
      '<input min="0" name="quantity_3" type="number" value="2">',
    );
    assertStringIncludes(body, "Save service event");
    assert(
      !body.includes("Create service event"),
      "the value should not contain the searched item",
    );
    assertStringIncludes(body, 'action="/admin/servicing/7/duplicate"');
    assertStringIncludes(body, 'action="/admin/servicing/7/delete"');
    assertStringIncludes(body, "Record service event cost");
    assertStringIncludes(body, 'name="cost_idempotency_key" type="hidden"');
    assertStringIncludes(body, 'name="amount"');
    assertStringIncludes(body, 'name="memo"');
    assertStringIncludes(body, 'name="target_listing_id"');
    assertStringIncludes(body, "Service event costs");
    assertStringIncludes(body, "Boiler part");
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

    assertStringIncludes(
      ownerBody,
      'href="/admin/ledger?listing=3">Main hall</a>',
    );
    assertStringIncludes(ownerBody, "Deleted listing");
    assertStringIncludes(
      ownerBody,
      `<td>${formatDateLabel("2026-07-01")}</td>`,
    );
    assertStringIncludes(
      ownerBody,
      `<td>${formatDateLabel("2026-07-02")}</td>`,
    );
    assertStringIncludes(
      ownerBody,
      `<td class="col-amount">${formatCurrency(9000)}</td>`,
    );
    assertStringIncludes(
      ownerBody,
      `<td class="col-amount">${formatCurrency(250)}</td>`,
    );
    assertStringIncludes(ownerBody, 'id="servicing-costs"');
    assertStringIncludes(ownerBody, 'class="listing-section"');
    assertStringIncludes(ownerBody, 'class="danger"');
    // One amount input in the record-cost form, one in each cost row editor.
    expect(ownerBody.match(/name="amount"/g)).toHaveLength(3);
  });

  test("keeps the cost table's money link owner-only", () => {
    const editorBody = renderCostsPage("editor");

    // The editor still sees the listing name, but the owner-only money link
    // stays off their table.
    assertStringIncludes(editorBody, "Main hall");
    assert(
      !editorBody.includes("/admin/ledger?listing="),
      "the value should not contain the searched item",
    );
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

    assertStringIncludes(
      list,
      '<tr class="servicing-event" data-servicing="true">',
    );
    assertStringIncludes(list, "Annual service");
    assertStringIncludes(list, 'href="/admin/servicing/7"');
    assertStringIncludes(
      list,
      `<td>${servicingEventDateLabel("2026-07-01")}</td>`,
    );
    assertStringIncludes(
      list,
      "<td>Main hall, Storage room, Deleted listing</td>",
    );
    assertStringIncludes(
      list,
      "<th>Name</th><th>Date</th><th>Listings</th><th>Quantity</th>",
    );
    assertStringIncludes(list, "<td>4</td>");
    assertStringIncludes(list, 'href="/admin/guide#servicing"');
    assertStringIncludes(list, "Servicing guide");

    const emptyList = renderServicingList(testSession(), [], []);
    assertStringIncludes(emptyList, "No service events yet.");
  });
});
