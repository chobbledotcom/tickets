import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import type { AttendeeFormLine } from "#routes/admin/attendee-form-model.ts";
import {
  buildAttendeeLogisticsData,
  endAgentField,
  endTimeField,
  parseLogisticsPlan,
  SPLIT_AGENTS_FIELD,
  startAgentField,
  startTimeField,
} from "#routes/admin/attendee-logistics.ts";
import { listingsTable } from "#shared/db/listings.ts";
import { getLogisticsAssignments } from "#shared/db/logistics.ts";
import { logisticsAgentsTable } from "#shared/db/logistics-agents.ts";
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
  listing: testListingWithCount({ id, uses_logistics: delivered }),
  listingId: id,
  noQuantity: false,
  quantity,
});

describe("attendee-logistics field names", () => {
  test("single vs split field names", () => {
    expect(startAgentField()).toBe("logistics_start");
    expect(startAgentField(7)).toBe("logistics_start_7");
    expect(endAgentField()).toBe("logistics_end");
    expect(endAgentField(7)).toBe("logistics_end_7");
  });
});

describe("parseLogisticsPlan", () => {
  const agentIds = new Set([1, 2]);

  test("single mode applies the one pair to every delivered booked line", () => {
    const form = new FormParams();
    form.set(startAgentField(), "1");
    form.set(endAgentField(), "2");
    const plan = parseLogisticsPlan(
      form,
      [bookedLine(10, true), bookedLine(11, true)],
      agentIds,
    );
    expect(plan.split).toBe(false);
    expect(plan.perListing.get(10)).toEqual({
      endAgentId: 2,
      endTime: "",
      startAgentId: 1,
      startTime: "",
    });
    expect(plan.perListing.get(11)).toEqual({
      endAgentId: 2,
      endTime: "",
      startAgentId: 1,
      startTime: "",
    });
  });

  test("split mode reads per-listing agent + time fields", () => {
    const form = new FormParams();
    form.set(SPLIT_AGENTS_FIELD, "1");
    form.set(startAgentField(10), "1");
    form.set(endAgentField(10), "2");
    form.set(startTimeField(10), "09:00");
    form.set(endTimeField(10), "17:30");
    const plan = parseLogisticsPlan(form, [bookedLine(10, true)], agentIds);
    expect(plan.split).toBe(true);
    expect(plan.perListing.get(10)).toEqual({
      endAgentId: 2,
      endTime: "17:30",
      startAgentId: 1,
      startTime: "09:00",
    });
  });

  test("unknown agent ids and non-delivered/unbooked lines are dropped", () => {
    const form = new FormParams();
    form.set(startAgentField(), "999"); // not a known agent
    form.set(endAgentField(), "2x");
    const plan = parseLogisticsPlan(
      form,
      [bookedLine(10, true), bookedLine(11, false), bookedLine(12, true, 0)],
      agentIds,
    );
    expect([...plan.perListing.keys()]).toEqual([10]);
    expect(plan.perListing.get(10)).toEqual({
      endAgentId: null,
      endTime: "",
      startAgentId: null,
      startTime: "",
    });
  });
});

describeWithEnv("buildAttendeeLogisticsData", { db: true }, () => {
  test("undefined when logistics is disabled", async () => {
    settings.setForTest({ has_logistics: false });
    expect(
      await buildAttendeeLogisticsData([bookedLine(1, true)], null),
    ).toBeUndefined();
  });

  test("undefined when no delivered listing is booked", async () => {
    settings.setForTest({ has_logistics: true });
    await logisticsAgentsTable.insert({ name: "Van" });
    expect(
      await buildAttendeeLogisticsData([bookedLine(1, false)], null),
    ).toBeUndefined();
  });

  test("undefined when there are no agents", async () => {
    settings.setForTest({ has_logistics: true });
    expect(
      await buildAttendeeLogisticsData([bookedLine(1, true)], null),
    ).toBeUndefined();
  });

  test("returns agents and an empty single pair for a create form", async () => {
    settings.setForTest({ has_logistics: true });
    await logisticsAgentsTable.insert({ name: "Van" });
    const data = await buildAttendeeLogisticsData([bookedLine(5, true)], null);
    expect(data!.agents.map((a) => a.name)).toEqual(["Van"]);
    expect(data!.split).toBe(false);
    expect(data!.single).toEqual({
      endAgentId: null,
      endTime: "",
      startAgentId: null,
      startTime: "",
    });
    expect(data!.lines.map((l) => l.listingId)).toEqual([5]);
  });
});

describeWithEnv("attendee form logistics (HTTP)", { db: true }, () => {
  const enableDeliveredListing = async () => {
    settings.setForTest({ has_logistics: true });
    const listing = await createTestListing({
      maxAttendees: 100,
      maxQuantity: 5,
    });
    await listingsTable.update(listing.id, { usesLogistics: true });
    const drop = await logisticsAgentsTable.insert({ name: "Drop Van" });
    const coll = await logisticsAgentsTable.insert({ name: "Coll Van" });
    return { coll, drop, listing };
  };

  /** POST the new-attendee form (session + CSRF handled), assert the redirect,
   * and return the first attendee's logistics assignment for `listingId`. */
  const submitNewAttendeeLogistics = async (
    listingId: number,
    fields: Record<string, string>,
  ) => {
    const { cookie, csrfToken } = await getTestSession();
    const response = await handleRequest(
      mockFormRequest(
        "/admin/attendees/new",
        { csrf_token: csrfToken, ...fields },
        cookie,
      ),
    );
    expect(response.status).toBe(302);
    const attendees = await getAttendeesRaw(listingId);
    const assignments = await getLogisticsAssignments(attendees[0]!.id);
    return assignments.get(listingId);
  };

  test("new form renders the logistics selectors for a delivered listing", async () => {
    const { listing } = await enableDeliveredListing();
    const { cookie } = await getTestSession();
    const response = await awaitTestRequest(
      `/admin/attendees/new?select_${listing.id}=1`,
      { cookie },
    );
    const html = await response.text();
    expect(html).toContain(">Logistics<");
    expect(html).toContain('name="logistics_start"');
    expect(html).toContain('name="logistics_end"');
    expect(html).toContain(`name="${SPLIT_AGENTS_FIELD}"`);
    // Per-listing (split mode) selectors and the time inputs are rendered too.
    expect(html).toContain(`name="${startAgentField(listing.id)}"`);
    expect(html).toContain('name="logistics_start_time"');
    expect(html).toContain("Drop Van");
  });

  test("creating an attendee persists the chosen agents", async () => {
    const { listing, drop, coll } = await enableDeliveredListing();
    const assignment = await submitNewAttendeeLogistics(listing.id, {
      [endAgentField()]: String(coll.id),
      [endTimeField()]: "16:45",
      [startAgentField()]: String(drop.id),
      [startTimeField()]: "08:30",
      name: "Jane",
      [`qty_${listing.id}`]: "1",
    });
    expect(assignment).toEqual({
      endAgentId: coll.id,
      endTime: "16:45",
      startAgentId: drop.id,
      startTime: "08:30",
    });
  });

  test("no logistics write happens when the feature is off", async () => {
    settings.setForTest({ has_logistics: false });
    const listing = await createTestListing({ maxAttendees: 100 });
    const assignment = await submitNewAttendeeLogistics(listing.id, {
      name: "NoLogistics",
      [`qty_${listing.id}`]: "1",
    });
    expect(assignment).toEqual({
      endAgentId: null,
      endTime: "",
      startAgentId: null,
      startTime: "",
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
          [startAgentField()]: String(drop.id),
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
          [endAgentField(listing.id)]: String(coll.id),
          csrf_token: csrfToken,
          [startAgentField(listing.id)]: String(coll.id),
          name: "Jane",
          [`qty_${listing.id}`]: "1",
          [SPLIT_AGENTS_FIELD]: "1",
        },
        cookie,
      ),
    );
    expect(editResponse.status).toBe(302);

    const assignments = await getLogisticsAssignments(attendeeId);
    expect(assignments.get(listing.id)).toEqual({
      endAgentId: coll.id,
      endTime: "",
      startAgentId: coll.id,
      startTime: "",
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
          [endAgentField()]: String(coll.id),
          [startAgentField()]: String(drop.id),
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
