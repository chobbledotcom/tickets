import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attendeeStatuses, getAttendeeStatus } from "#db/attendee-statuses.ts";
import { getDb } from "#db/client.ts";
import { insertRow } from "#db/record-table.ts";
import { tables } from "#db/select/tables.ts";
import { sql } from "#db/sql.ts";
import { expectUnauthorized } from "#test-utils/admin-api-auth.ts";
import {
  deleteJson,
  expectApiErrorIncludes,
  expectApiRecord,
  type JsonBody,
  postJson,
  putJson,
  requestAsManager,
} from "#test-utils/api/admin-json.ts";
import { assertJson, expectApiError } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { apiRequest } from "#test-utils/session.ts";

const STATUSES = "/api/admin/attendee-statuses";

/** The path of one status in the admin API. */
const statusPath = (id: number): string => `${STATUSES}/${id}`;

/** The status that an admin API answer holds. */
const expectStatus = expectApiRecord("status");

const RESERVATION_ONLY =
  "reservation_amount only applies to a reservation. Set is_reservation to true, or leave reservation_amount out.";

const createStatus = async (
  name: string,
  flags: { is_public_default?: boolean; is_paid_default?: boolean } = {},
): Promise<{ id: number; name: string }> =>
  insertRow(tables.attendee_statuses, { name, ...flags });

/** A reservation status that holds a quarter of the price. */
const createQuarterHold = () =>
  insertRow(tables.attendee_statuses, {
    is_reservation: true,
    name: "Reserved",
    reservation_amount: "25%",
  });

/** The status that every new site starts with. */
const seededStatus = async () => {
  const [seed] = await attendeeStatuses.getAll();
  if (seed === undefined) throw new Error("The site holds no status.");
  return seed;
};

/** Point one attendee at a status, the way a booking would. */
const holdStatus = async (statusId: number): Promise<void> => {
  await getDb().execute(
    sql`INSERT INTO attendees (created, pii_blob, status_id) VALUES (${new Date().toISOString()}, '', ${statusId})`,
  );
};

/** Assert that the admin API refuses to create this status with `message`. */
const expectCreateRefused = (body: JsonBody, message: string) =>
  expectApiError(postJson(STATUSES, body), 400, message);

/** Assert that the admin API refuses this change to one status with
 *  `message`. */
const expectUpdateRefused = (id: number, body: JsonBody, message: string) =>
  expectApiError(putJson(statusPath(id), body), 400, message);

/** Assert that the admin API refuses to delete one status with `message`,
 *  and that the status stays. */
const expectDeleteRefused = async (
  status: { id: number; name: string },
  message: string,
): Promise<void> => {
  await expectApiError(
    deleteJson(statusPath(status.id), { confirm_identifier: status.name }),
    400,
    message,
  );
  expect((await getAttendeeStatus(status.id))?.name).toBe(status.name);
};

describeWithEnv("Admin API - Attendee statuses", { db: true }, () => {
  describe("GET /api/admin/attendee-statuses", () => {
    test("lists every status with its flags and reservation amount", async () => {
      await createStatus("VIP");
      await createStatus("Reserved");

      await assertJson(apiRequest(STATUSES), 200, (body) => {
        const names = body["attendee-statuses"].map(
          (status: { name: string }) => status.name,
        );
        expect(names).toEqual(["Confirmed", "VIP", "Reserved"]);
        const confirmed = body["attendee-statuses"][0];
        expect(confirmed).toMatchObject({
          is_paid_default: true,
          is_public_default: true,
          is_reservation: false,
          name: "Confirmed",
          reservation_amount: "0",
        });
        // The answer carries the three default flags and the amount, but not
        // the dashboard-only sort order.
        expect(Object.hasOwn(confirmed, "sort_order")).toBe(false);
      });
    });

    test("returns 401 without auth", () => expectUnauthorized(STATUSES));
  });

  describe("GET /api/admin/attendee-statuses/:statusId", () => {
    test("returns a single status by ID", async () => {
      const status = await createStatus("Walk-in");

      await expectStatus(apiRequest(statusPath(status.id)), 200, (row) => {
        expect(row.name).toBe("Walk-in");
        expect(row.id).toBe(status.id);
        expect(row.is_reservation).toBe(false);
      });
    });

    test("returns 404 for a non-existent status", async () => {
      await expectApiError(
        apiRequest(statusPath(99999)),
        404,
        "Status not found",
      );
    });
  });

  describe("POST /api/admin/attendee-statuses", () => {
    test("creates a status that the list then shows", async () => {
      await expectStatus(
        postJson(STATUSES, {
          is_paid_default: false,
          is_public_default: false,
          is_reservation: true,
          name: "Reserved",
          reservation_amount: "25%",
        }),
        201,
        (row) => {
          expect(row.name).toBe("Reserved");
          expect(row.is_reservation).toBe(true);
          expect(row.reservation_amount).toBe("25%");
          expect(row.id).toBeGreaterThan(0);
        },
      );

      // The row is a real status: the admin UI's list reads from the same
      // table and now shows it.
      const all = await attendeeStatuses.getAll();
      expect(all.map((status) => status.name)).toContain("Reserved");
    });

    test("a new public default clears the previous one", async () => {
      await expectStatus(
        postJson(STATUSES, { is_public_default: true, name: "New default" }),
        201,
      );

      const defaults = (await attendeeStatuses.getAll()).filter(
        (status) => status.is_public_default,
      );
      expect(defaults.map((status) => status.name)).toEqual(["New default"]);
    });

    test("returns error when name is missing", async () => {
      await expectCreateRefused({}, "name is required");
    });

    test("refuses a name past the input length cap", async () => {
      await expectCreateRefused(
        { name: "x".repeat(251) },
        "Name must be 250 characters or fewer",
      );
    });

    test("refuses a flag that is not a boolean", async () => {
      await expectCreateRefused(
        { is_public_default: "yes", name: "Flagged" },
        "is_public_default must be a boolean",
      );
    });

    test("refuses a reservation amount that is not a string", async () => {
      await expectCreateRefused(
        { is_reservation: true, name: "Bad hold", reservation_amount: 25 },
        "reservation_amount must be a string",
      );
    });

    test("refuses a paid status that is also a reservation", async () => {
      await expectApiErrorIncludes(
        postJson(STATUSES, {
          is_paid_default: true,
          is_reservation: true,
          name: "Paid hold",
          reservation_amount: "10",
        }),
        400,
        "A paid status can't also be",
      );
    });

    test("refuses a reservation amount without the reservation flag", async () => {
      await expectCreateRefused(
        { name: "Hold", reservation_amount: "25%" },
        RESERVATION_ONLY,
      );
    });

    test("refuses a malformed reservation amount", async () => {
      await expectApiErrorIncludes(
        postJson(STATUSES, {
          is_reservation: true,
          name: "Bad hold",
          reservation_amount: "soon",
        }),
        400,
        "Enter an amount like 10",
      );
    });
  });

  describe("PUT /api/admin/attendee-statuses/:statusId", () => {
    test("updates the name", async () => {
      const status = await createStatus("Old name");

      await expectStatus(
        putJson(statusPath(status.id), { name: "New name" }),
        200,
        (row) => expect(row.name).toBe("New name"),
      );
    });

    test("an update keeps a reservation's stored amount", async () => {
      const status = await createQuarterHold();

      await expectStatus(
        putJson(statusPath(status.id), { name: "Reserved seat" }),
        200,
        (row) => {
          expect(row.is_reservation).toBe(true);
          expect(row.reservation_amount).toBe("25%");
        },
      );
    });

    test("refuses clearing the only public default", async () => {
      await expectUpdateRefused(
        (await seededStatus()).id,
        { is_public_default: false },
        "Choose another public default before clearing this one",
      );
    });

    test("refuses clearing the only paid default", async () => {
      await expectUpdateRefused(
        (await seededStatus()).id,
        { is_paid_default: false },
        "Choose another paid default before clearing this one",
      );
    });

    test("refuses an amount on a status that is not a reservation", async () => {
      const status = await createStatus("Plain");

      await expectUpdateRefused(
        status.id,
        { name: "Plain", reservation_amount: "10%" },
        RESERVATION_ONLY,
      );
    });

    test("refuses an amount when the update turns the reservation off", async () => {
      const status = await createQuarterHold();

      await expectUpdateRefused(
        status.id,
        { is_reservation: false, reservation_amount: "10%" },
        RESERVATION_ONLY,
      );
    });
  });

  describe("DELETE /api/admin/attendee-statuses/:statusId", () => {
    test("deletes a status no attendee holds", async () => {
      const status = await createStatus("Unused");

      await assertJson(
        deleteJson(statusPath(status.id), { confirm_identifier: "Unused" }),
        200,
        (body) => expect(body.status).toBe("ok"),
      );
      expect(await getAttendeeStatus(status.id)).toBeNull();
    });

    test("rejects a delete with the wrong confirmation", async () => {
      const status = await createStatus("Protected");

      await expectApiErrorIncludes(
        deleteJson(statusPath(status.id), { confirm_identifier: "Wrong" }),
        400,
        "does not match",
      );
      expect((await getAttendeeStatus(status.id))?.name).toBe("Protected");
    });

    test("refuses deleting the public default", async () => {
      const seed = await seededStatus();
      await createStatus("Spare");

      await expectDeleteRefused(
        seed,
        "Choose another public default before deleting this status",
      );
    });

    test("refuses deleting the last status", async () => {
      await expectDeleteRefused(
        await seededStatus(),
        "You must keep at least one status",
      );
    });

    test("refuses deleting a status attendees hold", async () => {
      const status = await createStatus("In use");
      await holdStatus(status.id);

      await expectDeleteRefused(
        status,
        "Choose another status for its attendees before deleting",
      );
    });
  });

  // Status settings are owner-only in the dashboard, so the JSON API must
  // reject managers too (a cookie-authenticated manager would otherwise reach
  // owner-gated operations through the API).
  describe("owner-only authorization", () => {
    test("rejects a manager listing statuses with 403", async () => {
      await expectApiError(requestAsManager(STATUSES), 403, "Forbidden");
    });

    test("rejects a manager creating a status with 403", async () => {
      const res = await requestAsManager(STATUSES, {
        body: { name: "Blocked" },
        method: "POST",
      });
      expect(res.status).toBe(403);
      expect(
        (await attendeeStatuses.getAll()).map((status) => status.name),
      ).not.toContain("Blocked");
    });

    test("rejects a manager deleting a status with 403", async () => {
      const status = await createStatus("Locked");
      const res = await requestAsManager(statusPath(status.id), {
        method: "DELETE",
      });
      expect(res.status).toBe(403);
      expect((await getAttendeeStatus(status.id))?.name).toBe("Locked");
    });
  });
});
