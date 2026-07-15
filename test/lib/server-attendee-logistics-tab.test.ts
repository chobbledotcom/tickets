/**
 * The attendee Logistics tab: rendering (address form, pin inputs, map) and
 * saving (address + pin into the PII blob, selectors onto booking rows),
 * including validation failures re-rendering in place. The Other Attendees
 * list, demo mode, and the failed-save selector behaviour live in
 * server-attendee-logistics-others.test.ts.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  endTimeField,
  startAgentField,
  startTimeField,
} from "#routes/admin/attendee-logistics.ts";
import { createAttendeeAtomic } from "#shared/db/attendees/api.ts";
import { getAttendee } from "#shared/db/attendees/queries.ts";
import { listingsTable } from "#shared/db/listings/records.ts";
import {
  getLogisticsAssignments,
  setLogisticsAssignments,
} from "#shared/db/logistics.ts";
import { settings } from "#shared/db/settings.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  deliveredListingSetup,
  logisticsTabHtml,
  makeAttendee,
  postLogistics,
} from "#test-utils/logistics-tab.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import { getTestSession } from "#test-utils/session.ts";
import { featureSetting } from "#test-utils/settings.ts";

describeWithEnv("attendee Logistics tab (GET)", { db: true }, () => {
  test("renders the address form, pin inputs, and a hidden map when unpinned", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const id = await makeAttendee("Tab Person", [{ listingId: listing.id }]);
    const html = await logisticsTabHtml(id);
    expect(html).toContain('name="address"');
    expect(html).toContain('name="lat"');
    expect(html).toContain('name="lng"');
    expect(html).toContain("data-logistics-map hidden");
    expect(html).toContain("data-address-diff");
  });

  test("the tab strip links to the Logistics tab", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const id = await makeAttendee("Strip Person", [{ listingId: listing.id }]);
    const html = await logisticsTabHtml(id);
    expect(html).toContain(`/admin/attendees/${id}/logistics`);
    expect(html).toContain(">Logistics<");
  });

  test("404s for an unknown attendee", async () => {
    const { cookie } = await getTestSession();
    const response = await awaitTestRequest(
      "/admin/attendees/999999/logistics",
      { cookie },
    );
    expect(response.status).toBe(404);
  });
});

describeWithEnv("attendee Logistics tab (POST)", { db: true }, () => {
  test("saves the address and pin, preserving the rest of the PII blob", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const result = await createAttendeeAtomic({
      bookings: [{ listingId: listing.id }],
      email: "pin@example.com",
      name: "Pin Person",
    });
    if (!result.success) throw new Error("creation failed");
    const created = result.attendees[0]!;

    const response = await postLogistics(created.id, {
      address: "10 Downing Street, LONDON, SW1A 2AA",
      lat: "51.503396",
      lng: "-0.127640",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain(
      `/admin/attendees/${created.id}/logistics`,
    );

    const saved = (await getAttendee(created.id, await getTestPrivateKey()))!;
    expect(saved.address).toBe("10 Downing Street, LONDON, SW1A 2AA");
    expect(saved.lat).toBe("51.503396");
    expect(saved.lng).toBe("-0.127640");
    expect(saved.name).toBe("Pin Person");
    expect(saved.email).toBe("pin@example.com");
    expect(saved.ticket_token).toBe(created.ticket_token);
  });

  test("a pinned attendee renders the pin values and a visible map", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const id = await makeAttendee("Visible Map", [{ listingId: listing.id }]);
    await postLogistics(id, { address: "Somewhere", lat: "51.5", lng: "-0.1" });

    const html = await logisticsTabHtml(id);
    expect(html).toContain('value="51.5"');
    expect(html).toContain('value="-0.1"');
    expect(html).not.toContain("data-logistics-map hidden");
    expect(html).toContain("data-logistics-map");
  });

  test("blank coordinates clear the pin", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const id = await makeAttendee("Unpin", [{ listingId: listing.id }]);
    await postLogistics(id, { address: "Somewhere", lat: "51.5", lng: "-0.1" });

    await postLogistics(id, { address: "Somewhere", lat: "", lng: "" });

    const saved = (await getAttendee(id, await getTestPrivateKey()))!;
    expect(saved.lat).toBe("");
    expect(saved.lng).toBe("");
  });

  test("an invalid pair re-renders at 400 with the error and saves nothing", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const id = await makeAttendee("Bad Pin", [{ listingId: listing.id }]);

    const response = await postLogistics(id, {
      address: "New Address",
      lat: "91",
      lng: "0",
    });
    expect(response.status).toBe(400);
    const html = await response.text();
    // The submitted values survive the re-render; the stored blob does not change.
    expect(html).toContain("New Address");
    expect(html).toContain('value="91"');
    expect(html).toContain("leave both empty");
    const saved = (await getAttendee(id, await getTestPrivateKey()))!;
    expect(saved.address).toBe("");
    expect(saved.lat).toBe("");
  });

  test("an over-long address re-renders at 400 with the address error", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const id = await makeAttendee("Long Address", [{ listingId: listing.id }]);

    const response = await postLogistics(id, {
      address: "x".repeat(251),
      lat: "",
      lng: "",
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("250");
  });

  test("404s for an unknown attendee", async () => {
    await createTestListing({ maxAttendees: 10 });
    const response = await postLogistics(999999, { address: "" });
    expect(response.status).toBe(404);
  });

  test("saves the start/end selectors for a delivered listing", async () => {
    const { id, listing, van } = await deliveredListingSetup(
      "Tab Van",
      "Legs Person",
    );

    const html = await logisticsTabHtml(id);
    expect(html).toContain('name="logistics_start"');
    expect(html).toContain("Tab Van");

    await postLogistics(id, {
      address: "Somewhere",
      [endTimeField()]: "17:00",
      lat: "",
      lng: "",
      [startAgentField()]: String(van.id),
      [startTimeField()]: "09:15",
    });

    expect((await getLogisticsAssignments(id)).get(listing.id)).toEqual({
      endAgentId: null,
      endTime: "17:00",
      startAgentId: van.id,
      startTime: "09:15",
    });
  });

  test("stored assignments survive a save while the selectors are not shown", async () => {
    settings.setForTest(featureSetting("logistics"));
    const listing = await createTestListing({ maxAttendees: 10 });
    await listingsTable.update(listing.id, { usesLogistics: true });
    const id = await makeAttendee("Keep Legs", [{ listingId: listing.id }]);
    // An assignment exists, but with no agents the selectors never render.
    await setLogisticsAssignments(
      id,
      false,
      new Map([
        [
          listing.id,
          {
            endAgentId: null,
            endTime: "16:00",
            startAgentId: null,
            startTime: "08:00",
          },
        ],
      ]),
    );

    await postLogistics(id, { address: "Somewhere", lat: "", lng: "" });

    expect((await getLogisticsAssignments(id)).get(listing.id)).toEqual({
      endAgentId: null,
      endTime: "16:00",
      startAgentId: null,
      startTime: "08:00",
    });
  });
});
