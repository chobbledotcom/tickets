import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import {
  createServicingHold,
  createTestServicingEvent,
  getServicingEvent,
  renderAdminPage,
  updateServicingEvent,
} from "#test-utils/servicing.ts";
import { adminFormPost } from "#test-utils/session.ts";

describeWithEnv("admin servicing routes", { db: true }, () => {
  beforeAll(setupAdminPageTest);

  test("the servicing list route renders service-event row details", async () => {
    const listing = await createDailyTestListing({
      maxAttendees: 5,
      name: "Route Room",
    });
    const event = await createTestServicingEvent({
      bookings: [{ date: "2099-07-01", listingId: listing.id, quantity: 2 }],
      name: "Route Service",
    });
    const deletedListing = await createTestListing({
      maxAttendees: 5,
      name: "Deleted Route Listing",
    });
    await createTestServicingEvent({
      bookings: [{ listingId: deletedListing.id, quantity: 1 }],
      name: "Undated Route Service",
    });
    await getDb().execute({
      args: [deletedListing.id],
      sql: "DELETE FROM listings WHERE id = ?",
    });

    const html = await renderAdminPage("/admin/servicing");

    assertStringIncludes(html, 'class="servicing-event"');
    assertStringIncludes(html, `/admin/servicing/${event.id}`);
    assertStringIncludes(html, "Route Service");
    assertStringIncludes(html, "Route Room");
    assertStringIncludes(html, "<td>2</td>");
    assertStringIncludes(html, "Undated Route Service");
    assert(
      !html.includes("Deleted Route Listing"),
      "the value should not contain the searched item",
    );
  });

  test("the servicing update route updates name and booking quantity", async () => {
    const { id, listing } = await createServicingHold({
      name: "Before Route Update",
      quantity: 3,
    });

    // The page's quantity input is named `quantity_<listing id>`; a field with
    // any other name is dropped by the form parser, so the POST below must
    // use the real name or the route rejects it.
    const { response } = await adminFormPost(`/admin/servicing/${id}`, {
      name: "After Route Update",
      [`quantity_${listing.id}`]: "1",
    });

    assertStringIncludes(
      response.headers.get("location") ?? "",
      `/admin/servicing/${id}`,
    );
    // Read the row the route itself wrote — the next helper call would
    // overwrite it, and a rejected POST must not pass this assertion.
    const saved = await getServicingEvent(id);
    expect(saved).toMatchObject({
      bookings: [{ listingId: listing.id, quantity: 1 }],
      name: "After Route Update",
    });
    // A booking without an explicit quantity keeps the default of one.
    const updated = await updateServicingEvent(id, {
      bookings: [{ listingId: listing.id }],
      name: "Default Quantity Update",
    });
    expect(updated.bookings[0]!.quantity).toBe(1);
  });

  test("the servicing update route records costs when amount is present", async () => {
    const { id, listing } = await createServicingHold({
      name: "Route Cost",
    });

    const { response } = await adminFormPost(`/admin/servicing/${id}`, {
      amount: "12.34",
      memo: "Route cost",
      target_listing_id: String(listing.id),
    });

    assertStringIncludes(
      response.headers.get("location") ?? "",
      `/admin/servicing/${id}`,
    );
  });

  test("servicing mutation routes return not found for missing events", async () => {
    const { response: editResponse } = await adminFormPost(
      "/admin/servicing/999999",
      {
        name: "Missing",
        quantity_1: "1",
      },
    );
    expect(editResponse.status).toBe(404);

    const { response: costResponse } = await adminFormPost(
      "/admin/servicing/999999/cost/1",
      {
        amount: "1.00",
      },
    );
    expect(costResponse.status).toBe(404);
  });

  test("servicing create rejects retained zero-quantity and over-capacity holds", async () => {
    const listing = await createDailyTestListing({
      maxAttendees: 1,
      name: "Validation Room",
    });

    // A zero-quantity form submission: the route catches the validation error
    // and redirects back to the create form (not a 500).
    const { response: noQtyResponse } = await adminFormPost(
      "/admin/servicing/new",
      {
        name: "No Quantity Service",
        [`quantity_${listing.id}`]: "0",
      },
    );
    expect(noQtyResponse.status).toBe(302);
    assertStringIncludes(
      noQtyResponse.headers.get("location") ?? "",
      "/admin/servicing/new",
    );
    noQtyResponse.body?.cancel();

    await expect(
      createTestServicingEvent({
        bookings: [{ date: "2099-07-01", listingId: listing.id, quantity: 0 }],
        name: "Zero Quantity Service",
      }),
    ).rejects.toThrow("capacity slot");

    await expect(
      createTestServicingEvent({
        bookings: [],
        name: "Empty Service",
      }),
    ).rejects.toThrow("capacity slot");

    const defaultQuantity = await createTestServicingEvent({
      bookings: [{ date: "2099-07-02", listingId: listing.id }],
      name: "Default Quantity Service",
    });
    expect(defaultQuantity.bookings[0]!.quantity).toBe(1);

    await expect(
      createTestServicingEvent({
        bookings: [{ date: "2099-07-01", listingId: listing.id, quantity: 2 }],
        name: "Over Capacity Service",
      }),
    ).rejects.toThrow();
  });
});
