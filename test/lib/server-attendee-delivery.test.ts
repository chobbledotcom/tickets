import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import {
  buildAttendeeDeliveryData,
  collectionAgentField,
  dropOffAgentField,
  parseDeliveryPlan,
  SPLIT_AGENTS_FIELD,
} from "#routes/admin/attendee-delivery.ts";
import type { AttendeeFormLine } from "#routes/admin/attendee-form-model.ts";
import { getDeliveryAssignments } from "#shared/db/delivery.ts";
import { deliveryAgentsTable } from "#shared/db/delivery-agents.ts";
import { listingsTable } from "#shared/db/listings.ts";
import { settings } from "#shared/db/settings.ts";
import { FormParams } from "#shared/form-data.ts";
import {
  adminGet,
  awaitTestRequest,
  createTestListing,
  describeWithEnv,
  getAttendeesRaw,
  getTestSession,
  testListingWithCount,
} from "#test-utils";
import { mockFormRequest } from "#test-utils/mocks.ts";

/** Build a booked editor line for the given listing. */
const bookedLine = (
  id: number,
  delivered: boolean,
  quantity = 1,
): AttendeeFormLine => ({
  error: null,
  existingBooking: null,
  key: "",
  listing: testListingWithCount({ delivered, id }),
  listingId: id,
  quantity,
});

describe("attendee-delivery field names", () => {
  test("single vs split field names", () => {
    expect(dropOffAgentField()).toBe("delivery_drop_off");
    expect(dropOffAgentField(7)).toBe("delivery_drop_off_7");
    expect(collectionAgentField()).toBe("delivery_collection");
    expect(collectionAgentField(7)).toBe("delivery_collection_7");
  });
});

describe("parseDeliveryPlan", () => {
  const agentIds = new Set([1, 2]);

  test("single mode applies the one pair to every delivered booked line", () => {
    const form = new FormParams();
    form.set(dropOffAgentField(), "1");
    form.set(collectionAgentField(), "2");
    const plan = parseDeliveryPlan(
      form,
      [bookedLine(10, true), bookedLine(11, true)],
      agentIds,
    );
    expect(plan.split).toBe(false);
    expect(plan.perListing.get(10)).toEqual({
      collectionAgentId: 2,
      dropOffAgentId: 1,
    });
    expect(plan.perListing.get(11)).toEqual({
      collectionAgentId: 2,
      dropOffAgentId: 1,
    });
  });

  test("split mode reads per-listing fields", () => {
    const form = new FormParams();
    form.set(SPLIT_AGENTS_FIELD, "1");
    form.set(dropOffAgentField(10), "1");
    form.set(collectionAgentField(10), "2");
    const plan = parseDeliveryPlan(form, [bookedLine(10, true)], agentIds);
    expect(plan.split).toBe(true);
    expect(plan.perListing.get(10)).toEqual({
      collectionAgentId: 2,
      dropOffAgentId: 1,
    });
  });

  test("unknown agent ids and non-delivered/unbooked lines are dropped", () => {
    const form = new FormParams();
    form.set(dropOffAgentField(), "999"); // not a known agent
    const plan = parseDeliveryPlan(
      form,
      [bookedLine(10, true), bookedLine(11, false), bookedLine(12, true, 0)],
      agentIds,
    );
    expect([...plan.perListing.keys()]).toEqual([10]);
    expect(plan.perListing.get(10)).toEqual({
      collectionAgentId: null,
      dropOffAgentId: null,
    });
  });
});

describeWithEnv("buildAttendeeDeliveryData", { db: true }, () => {
  test("undefined when delivery is disabled", async () => {
    settings.setForTest({ has_delivery: false });
    expect(
      await buildAttendeeDeliveryData([bookedLine(1, true)], null),
    ).toBeUndefined();
  });

  test("undefined when no delivered listing is booked", async () => {
    settings.setForTest({ has_delivery: true });
    await deliveryAgentsTable.insert({ name: "Van" });
    expect(
      await buildAttendeeDeliveryData([bookedLine(1, false)], null),
    ).toBeUndefined();
  });

  test("undefined when there are no agents", async () => {
    settings.setForTest({ has_delivery: true });
    expect(
      await buildAttendeeDeliveryData([bookedLine(1, true)], null),
    ).toBeUndefined();
  });

  test("returns agents and an empty single pair for a create form", async () => {
    settings.setForTest({ has_delivery: true });
    await deliveryAgentsTable.insert({ name: "Van" });
    const data = await buildAttendeeDeliveryData([bookedLine(5, true)], null);
    expect(data!.agents.map((a) => a.name)).toEqual(["Van"]);
    expect(data!.split).toBe(false);
    expect(data!.single).toEqual({
      collectionAgentId: null,
      dropOffAgentId: null,
    });
    expect(data!.lines.map((l) => l.listingId)).toEqual([5]);
  });
});

describeWithEnv("attendee form delivery (HTTP)", { db: true }, () => {
  const enableDeliveredListing = async () => {
    settings.setForTest({ has_delivery: true });
    const listing = await createTestListing({
      maxAttendees: 100,
      maxQuantity: 5,
    });
    await listingsTable.update(listing.id, { delivered: true });
    const drop = await deliveryAgentsTable.insert({ name: "Drop Van" });
    const coll = await deliveryAgentsTable.insert({ name: "Coll Van" });
    return { coll, drop, listing };
  };

  test("new form renders the delivery selectors for a delivered listing", async () => {
    const { listing } = await enableDeliveredListing();
    const { cookie } = await getTestSession();
    const response = await awaitTestRequest(
      `/admin/attendees/new?select_${listing.id}=1`,
      { cookie },
    );
    const html = await response.text();
    expect(html).toContain(">Delivery<");
    expect(html).toContain('name="delivery_drop_off"');
    expect(html).toContain('name="delivery_collection"');
    expect(html).toContain(`name="${SPLIT_AGENTS_FIELD}"`);
    // Per-listing (split mode) selectors are rendered too.
    expect(html).toContain(`name="${dropOffAgentField(listing.id)}"`);
    expect(html).toContain("Drop Van");
  });

  test("creating an attendee persists the chosen agents", async () => {
    const { listing, drop, coll } = await enableDeliveredListing();
    const { cookie, csrfToken } = await getTestSession();
    const response = await handleRequest(
      mockFormRequest(
        "/admin/attendees/new",
        {
          csrf_token: csrfToken,
          [collectionAgentField()]: String(coll.id),
          [dropOffAgentField()]: String(drop.id),
          name: "Jane",
          [`qty_${listing.id}`]: "1",
        },
        cookie,
      ),
    );
    expect(response.status).toBe(302);
    const attendees = await getAttendeesRaw(listing.id);
    const assignments = await getDeliveryAssignments(attendees[0]!.id);
    expect(assignments.get(listing.id)).toEqual({
      collectionAgentId: coll.id,
      dropOffAgentId: drop.id,
    });
  });

  test("no delivery write happens when the feature is off", async () => {
    settings.setForTest({ has_delivery: false });
    const listing = await createTestListing({ maxAttendees: 100 });
    const { cookie, csrfToken } = await getTestSession();
    const response = await handleRequest(
      mockFormRequest(
        "/admin/attendees/new",
        {
          csrf_token: csrfToken,
          name: "NoDelivery",
          [`qty_${listing.id}`]: "1",
        },
        cookie,
      ),
    );
    expect(response.status).toBe(302);
    const attendees = await getAttendeesRaw(listing.id);
    const assignments = await getDeliveryAssignments(attendees[0]!.id);
    expect(assignments.get(listing.id)).toEqual({
      collectionAgentId: null,
      dropOffAgentId: null,
    });
  });

  test("editing with split mode saves per-listing agents", async () => {
    const { listing, drop, coll } = await enableDeliveredListing();
    const { cookie, csrfToken } = await getTestSession();
    await handleRequest(
      mockFormRequest(
        "/admin/attendees/new",
        {
          csrf_token: csrfToken,
          [dropOffAgentField()]: String(drop.id),
          name: "Jane",
          [`qty_${listing.id}`]: "1",
        },
        cookie,
      ),
    );
    const attendeeId = (await getAttendeesRaw(listing.id))[0]!.id;

    const editResponse = await handleRequest(
      mockFormRequest(
        `/admin/attendees/${attendeeId}`,
        {
          [collectionAgentField(listing.id)]: String(coll.id),
          csrf_token: csrfToken,
          [dropOffAgentField(listing.id)]: String(coll.id),
          name: "Jane",
          [`qty_${listing.id}`]: "1",
          [SPLIT_AGENTS_FIELD]: "1",
        },
        cookie,
      ),
    );
    expect(editResponse.status).toBe(302);

    const assignments = await getDeliveryAssignments(attendeeId);
    expect(assignments.get(listing.id)).toEqual({
      collectionAgentId: coll.id,
      dropOffAgentId: coll.id,
    });
  });

  test("the edit form pre-selects saved agents", async () => {
    const { listing, drop, coll } = await enableDeliveredListing();
    const { cookie, csrfToken } = await getTestSession();
    await handleRequest(
      mockFormRequest(
        "/admin/attendees/new",
        {
          csrf_token: csrfToken,
          [collectionAgentField()]: String(coll.id),
          [dropOffAgentField()]: String(drop.id),
          name: "Jane",
          [`qty_${listing.id}`]: "1",
        },
        cookie,
      ),
    );
    const attendees = await getAttendeesRaw(listing.id);
    const { response } = await adminGet(`/admin/attendees/${attendees[0]!.id}`);
    const html = await response.text();
    // The saved drop-off agent option is rendered selected.
    expect(html).toMatch(
      new RegExp(`<option selected value="${drop.id}">Drop Van</option>`),
    );
  });
});
