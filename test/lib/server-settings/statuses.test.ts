import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  attendeeStatusesTable,
  getAllAttendeeStatuses,
  getAttendeeStatus,
  getPublicDefaultStatus,
} from "#shared/db/attendee-statuses.ts";
import { getDb } from "#shared/db/client.ts";
import { RESERVATION_AMOUNT_HINT } from "#shared/reservation-amount.ts";
import {
  adminFormPost,
  adminGet,
  describeWithEnv,
  expectHtmlResponse,
  expectRedirectWithFlash,
  testRequiresAuth,
} from "#test-utils";

const PATH = "/admin/settings/statuses";

/** The seed status created by the migration (public + paid default). */
const seedStatus = async () => (await getAllAttendeeStatuses())[0]!;

describeWithEnv("server (admin attendee statuses)", { db: true }, () => {
  describe("GET /admin/settings/statuses", () => {
    testRequiresAuth(PATH);

    test("lists the seeded default status", async () => {
      const { response } = await adminGet(PATH);
      await expectHtmlResponse(
        response,
        200,
        "Attendee Statuses",
        "Confirmed",
        "Add status",
      );
    });

    test("renders flag badges and reorder controls", async () => {
      await attendeeStatusesTable.insert({
        isReservation: true,
        name: "Reserved",
        reservationAmount: "10%",
        sortOrder: 1,
      });
      const { response } = await adminGet(PATH);
      const html = await response.text();
      // Seed badges + the reservation badge.
      expect(html).toContain("Public default");
      expect(html).toContain("Paid");
      expect(html).toContain("Reservation: 10%");
      // With two rows, both move-up (▲) and move-down (▼) controls render.
      expect(html).toContain("▲");
      expect(html).toContain("▼");
    });
  });

  describe("GET /admin/settings/statuses/new", () => {
    test("renders the create form", async () => {
      const { response } = await adminGet(`${PATH}/new`);
      await expectHtmlResponse(response, 200, "Add Attendee Status", "Name");
    });
  });

  describe("POST /admin/settings/statuses (create)", () => {
    test("creates a reservation status with a deposit amount", async () => {
      const { response } = await adminFormPost(PATH, {
        is_reservation: "1",
        name: "Reserved",
        reservation_amount: "10%",
      });
      expectRedirectWithFlash(PATH, "Status created")(response);

      const statuses = await getAllAttendeeStatuses();
      const created = statuses.find((s) => s.name === "Reserved")!;
      expect(created.is_reservation).toBe(true);
      expect(created.reservation_amount).toBe("10%");
      // Assigned the next sort_order after the seed (0).
      expect(created.sort_order).toBe(1);
    });

    test("rejects a missing name", async () => {
      const { response } = await adminFormPost(PATH, { name: "" });
      expectRedirectWithFlash(
        `${PATH}/new`,
        "Please enter a name",
        false,
      )(response);
    });

    test("rejects an invalid reservation amount", async () => {
      const { response } = await adminFormPost(PATH, {
        is_reservation: "1",
        name: "Bad",
        reservation_amount: "lots",
      });
      expectRedirectWithFlash(
        `${PATH}/new`,
        RESERVATION_AMOUNT_HINT,
        false,
      )(response);
    });

    test("rejects a status that is both a reservation and the paid default", async () => {
      const { response } = await adminFormPost(PATH, {
        is_paid_default: "1",
        is_reservation: "1",
        name: "Contradiction",
        reservation_amount: "10",
      });
      expectRedirectWithFlash(
        `${PATH}/new`,
        "A paid status can't also be a reservation",
        false,
      )(response);
    });

    test("setting a new public default clears it from the others", async () => {
      const seed = await seedStatus();
      expect(seed.is_public_default).toBe(true);

      const { response } = await adminFormPost(PATH, {
        is_public_default: "1",
        name: "New Default",
      });
      expectRedirectWithFlash(PATH, "Status created")(response);

      const newDefault = await getPublicDefaultStatus();
      expect(newDefault?.name).toBe("New Default");
      // The seed is no longer the public default.
      expect((await getAttendeeStatus(seed.id))?.is_public_default).toBe(false);
    });

    test("setting a new paid default clears it from the others", async () => {
      const seed = await seedStatus();
      const { response } = await adminFormPost(PATH, {
        is_paid_default: "1",
        name: "Settled",
      });
      expectRedirectWithFlash(PATH, "Status created")(response);
      expect((await getAttendeeStatus(seed.id))?.is_paid_default).toBe(false);
    });
  });

  describe("POST /admin/settings/statuses/:id/edit", () => {
    test("renames a status", async () => {
      const created = await attendeeStatusesTable.insert({ name: "Old" });
      const { response } = await adminFormPost(`${PATH}/${created.id}/edit`, {
        name: "Renamed",
      });
      expectRedirectWithFlash(PATH, "Status updated")(response);
      expect((await getAttendeeStatus(created.id))?.name).toBe("Renamed");
    });

    test("refuses to clear the only public default", async () => {
      const seed = await seedStatus();
      const { response } = await adminFormPost(`${PATH}/${seed.id}/edit`, {
        // is_public_default omitted → attempting to clear it
        is_paid_default: "1",
        name: "Confirmed",
      });
      expectRedirectWithFlash(
        `${PATH}/${seed.id}/edit`,
        "Choose another public default before clearing this one",
        false,
      )(response);
    });

    test("renders the edit form for an existing status", async () => {
      const seed = await seedStatus();
      const { response } = await adminGet(`${PATH}/${seed.id}/edit`);
      await expectHtmlResponse(response, 200, "Edit Attendee Status");
    });

    test("pre-fills a reservation status's fields when editing", async () => {
      const reserved = await attendeeStatusesTable.insert({
        isReservation: true,
        name: "Reserved",
        reservationAmount: "25%",
      });
      const { response } = await adminGet(`${PATH}/${reserved.id}/edit`);
      const html = await response.text();
      // The reservation checkbox is checked and the amount is pre-filled.
      expect(html).toContain('value="25%"');
      expect(html).toContain("checked");
    });

    test("returns 404 editing a missing status", async () => {
      const { response } = await adminFormPost(`${PATH}/9999/edit`, {
        name: "Ghost",
      });
      expect(response.status).toBe(404);
    });

    test("rejects an invalid edit", async () => {
      const seed = await seedStatus();
      const { response } = await adminFormPost(`${PATH}/${seed.id}/edit`, {
        name: "",
      });
      expectRedirectWithFlash(
        `${PATH}/${seed.id}/edit`,
        "Please enter a name",
        false,
      )(response);
    });

    test("refuses to clear the only paid default", async () => {
      const seed = await seedStatus();
      const { response } = await adminFormPost(`${PATH}/${seed.id}/edit`, {
        is_public_default: "1",
        name: "Confirmed",
      });
      expectRedirectWithFlash(
        `${PATH}/${seed.id}/edit`,
        "Choose another paid default before clearing this one",
        false,
      )(response);
    });
  });

  describe("POST /admin/settings/statuses/:id/delete", () => {
    test("refuses to delete the last status", async () => {
      const seed = await seedStatus();
      const { response } = await adminFormPost(`${PATH}/${seed.id}/delete`);
      expectRedirectWithFlash(
        PATH,
        "You must keep at least one status",
        false,
      )(response);
    });

    test("refuses to delete the public default", async () => {
      const seed = await seedStatus();
      await attendeeStatusesTable.insert({ name: "Spare" });
      const { response } = await adminFormPost(`${PATH}/${seed.id}/delete`);
      expectRedirectWithFlash(
        PATH,
        "Choose another public default before deleting this status",
        false,
      )(response);
    });

    test("refuses to delete a status that is in use", async () => {
      const inUse = await attendeeStatusesTable.insert({ name: "Active" });
      await getDb().execute({
        args: [inUse.id],
        sql: "INSERT INTO attendees (created, pii_blob, status_id) VALUES ('2024-01-01T00:00:00Z', '', ?)",
      });
      const { response } = await adminFormPost(`${PATH}/${inUse.id}/delete`);
      expectRedirectWithFlash(
        PATH,
        "This status is in use by attendees",
        false,
      )(response);
    });

    test("deletes a spare, unused status", async () => {
      const spare = await attendeeStatusesTable.insert({ name: "Disposable" });
      const { response } = await adminFormPost(`${PATH}/${spare.id}/delete`);
      expectRedirectWithFlash(PATH, "Status deleted")(response);
      expect(await getAttendeeStatus(spare.id)).toBeNull();
    });

    test("returns 404 deleting a missing status", async () => {
      const { response } = await adminFormPost(`${PATH}/9999/delete`);
      expect(response.status).toBe(404);
    });

    test("refuses to delete the paid default", async () => {
      // Move the paid default onto a new (non-public) status, then delete it.
      await adminFormPost(PATH, { is_paid_default: "1", name: "Settled" });
      const settled = (await getAllAttendeeStatuses()).find(
        (s) => s.name === "Settled",
      )!;
      const { response } = await adminFormPost(`${PATH}/${settled.id}/delete`);
      expectRedirectWithFlash(
        PATH,
        "Choose another paid default before deleting this status",
        false,
      )(response);
    });
  });

  describe("POST /admin/settings/statuses/:id/move", () => {
    test("moves a status up past its neighbour", async () => {
      // Seed is sort_order 0; add two more at 1 and 2.
      const first = await attendeeStatusesTable.insert({
        name: "First",
        sortOrder: 1,
      });
      const second = await attendeeStatusesTable.insert({
        name: "Second",
        sortOrder: 2,
      });
      const { response } = await adminFormPost(`${PATH}/${second.id}/move-up`);
      expectRedirectWithFlash(PATH, "Status moved")(response);

      const order = (await getAllAttendeeStatuses()).map((s) => s.name);
      const firstIdx = order.indexOf("First");
      const secondIdx = order.indexOf("Second");
      expect(secondIdx).toBeLessThan(firstIdx);
      // Avoid an unused-variable lint on `first`.
      expect(first.name).toBe("First");
    });

    test("move at the boundary is a no-op", async () => {
      const seed = await seedStatus();
      const { response } = await adminFormPost(`${PATH}/${seed.id}/move-up`);
      expectRedirectWithFlash(PATH, "Status moved")(response);
    });

    test("returns 404 moving a missing status", async () => {
      const { response } = await adminFormPost(`${PATH}/9999/move-up`);
      expect(response.status).toBe(404);
    });
  });
});
