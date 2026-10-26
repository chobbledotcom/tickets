import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { runApi } from "#cli/run.ts";
import { attendeeStatuses, getAttendeeStatus } from "#db/attendee-statuses.ts";
import { getDb } from "#db/client.ts";
import { handleRequest } from "#routes";
import { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import { adminApiTestTransport } from "#test-utils/admin-api-transport.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { runDeps } from "#test-utils/cli-table.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import {
  apiRequest,
  createTestManagerSession,
  requestAsSession,
  testCsrfToken,
} from "#test-utils/session.ts";

const createStatus = async (
  name: string,
  flags: { is_public_default?: boolean; is_paid_default?: boolean } = {},
): Promise<{ id: number; name: string }> =>
  attendeeStatuses.table.insert({ name, ...flags });

/** Point one attendee at a status, the way a booking would. */
const holdStatus = async (statusId: number): Promise<void> => {
  await getDb().execute({
    args: [new Date().toISOString(), statusId],
    sql: "INSERT INTO attendees (created, pii_blob, status_id) VALUES (?, '', ?)",
  });
};

describeWithEnv("Admin API - Attendee statuses", { db: true }, () => {
  describe("GET /api/admin/attendee-statuses", () => {
    test("lists every status with its flags and reservation amount", async () => {
      await createStatus("VIP");
      await createStatus("Reserved");

      await assertJson(
        apiRequest("/api/admin/attendee-statuses"),
        200,
        (body) => {
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
          expect(confirmed.sort_order).toBeUndefined();
        },
      );
    });

    test("returns 401 without auth", async () => {
      const response = await handleRequest(
        mockRequest("/api/admin/attendee-statuses"),
      );
      expect(response.status).toBe(401);
    });
  });

  describe("GET /api/admin/attendee-statuses/:statusId", () => {
    test("returns a single status by ID", async () => {
      const status = await createStatus("Walk-in");

      await assertJson(
        apiRequest(`/api/admin/attendee-statuses/${status.id}`),
        200,
        (body) => {
          expect(body.status.name).toBe("Walk-in");
          expect(body.status.id).toBe(status.id);
          expect(body.status.is_reservation).toBe(false);
        },
      );
    });

    test("returns 404 for a non-existent status", async () => {
      await assertJson(
        apiRequest("/api/admin/attendee-statuses/99999"),
        404,
        (body) => {
          expect(body.error).toBe("Status not found");
        },
      );
    });
  });

  describe("POST /api/admin/attendee-statuses", () => {
    test("creates a status that the list then shows", async () => {
      await assertJson(
        apiRequest("/api/admin/attendee-statuses", {
          body: {
            is_paid_default: false,
            is_public_default: false,
            is_reservation: true,
            name: "Reserved",
            reservation_amount: "25%",
          },
          method: "POST",
        }),
        201,
        (body) => {
          expect(body.status.name).toBe("Reserved");
          expect(body.status.is_reservation).toBe(true);
          expect(body.status.reservation_amount).toBe("25%");
          expect(body.status.id).toBeGreaterThan(0);
        },
      );

      // The row is a real status: the admin UI's list reads from the same
      // table and now shows it.
      const all = await attendeeStatuses.getAll();
      expect(all.some((status) => status.name === "Reserved")).toBe(true);
    });

    test("a new public default clears the previous one", async () => {
      await assertJson(
        apiRequest("/api/admin/attendee-statuses", {
          body: { is_public_default: true, name: "New default" },
          method: "POST",
        }),
        201,
        () => {},
      );

      const defaults = (await attendeeStatuses.getAll()).filter(
        (status) => status.is_public_default,
      );
      expect(defaults.map((status) => status.name)).toEqual(["New default"]);
    });

    test("returns error when name is missing", async () => {
      await assertJson(
        apiRequest("/api/admin/attendee-statuses", {
          body: {},
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toBe("name is required");
        },
      );
    });

    test("refuses a paid status that is also a reservation", async () => {
      await assertJson(
        apiRequest("/api/admin/attendee-statuses", {
          body: {
            is_paid_default: true,
            is_reservation: true,
            name: "Paid hold",
            reservation_amount: "10",
          },
          method: "POST",
        }),
        400,
        (body) => {
          assertStringIncludes(body.error, "A paid status can't also be");
        },
      );
    });

    test("refuses a malformed reservation amount", async () => {
      await assertJson(
        apiRequest("/api/admin/attendee-statuses", {
          body: {
            is_reservation: true,
            name: "Bad hold",
            reservation_amount: "soon",
          },
          method: "POST",
        }),
        400,
        (body) => {
          assertStringIncludes(body.error, "Enter an amount like 10");
        },
      );
    });
  });

  describe("PUT /api/admin/attendee-statuses/:statusId", () => {
    test("updates the name", async () => {
      const status = await createStatus("Old name");

      await assertJson(
        apiRequest(`/api/admin/attendee-statuses/${status.id}`, {
          body: { name: "New name" },
          method: "PUT",
        }),
        200,
        (body) => {
          expect(body.status.name).toBe("New name");
        },
      );
    });

    test("refuses clearing the only public default", async () => {
      const [seed] = await attendeeStatuses.getAll();

      await assertJson(
        apiRequest(`/api/admin/attendee-statuses/${seed!.id}`, {
          body: { is_public_default: false },
          method: "PUT",
        }),
        400,
        (body) => {
          expect(body.error).toBe(
            "Choose another public default before clearing this one",
          );
        },
      );
    });
  });

  describe("DELETE /api/admin/attendee-statuses/:statusId", () => {
    test("deletes a status no attendee holds", async () => {
      const status = await createStatus("Unused");

      await assertJson(
        apiRequest(`/api/admin/attendee-statuses/${status.id}`, {
          body: { confirm_identifier: "Unused" },
          method: "DELETE",
        }),
        200,
        (body) => {
          expect(body.status).toBe("ok");
        },
      );
      expect(await getAttendeeStatus(status.id)).toBeNull();
    });

    test("rejects a delete with the wrong confirmation", async () => {
      const status = await createStatus("Protected");

      await assertJson(
        apiRequest(`/api/admin/attendee-statuses/${status.id}`, {
          body: { confirm_identifier: "Wrong" },
          method: "DELETE",
        }),
        400,
        (body) => {
          assertStringIncludes(body.error, "does not match");
        },
      );
      expect(await getAttendeeStatus(status.id)).not.toBeNull();
    });

    test("refuses deleting the public default", async () => {
      const [seed] = await attendeeStatuses.getAll();
      await createStatus("Spare");

      await assertJson(
        apiRequest(`/api/admin/attendee-statuses/${seed!.id}`, {
          body: { confirm_identifier: "Confirmed" },
          method: "DELETE",
        }),
        400,
        (body) => {
          expect(body.error).toBe(
            "Choose another public default before deleting this status",
          );
        },
      );
    });

    test("refuses deleting the last status", async () => {
      const [seed] = await attendeeStatuses.getAll();

      await assertJson(
        apiRequest(`/api/admin/attendee-statuses/${seed!.id}`, {
          body: { confirm_identifier: "Confirmed" },
          method: "DELETE",
        }),
        400,
        (body) => {
          expect(body.error).toBe("You must keep at least one status");
        },
      );
      expect(await getAttendeeStatus(seed!.id)).not.toBeNull();
    });

    test("refuses deleting a status attendees hold", async () => {
      const status = await createStatus("In use");
      await holdStatus(status.id);

      await assertJson(
        apiRequest(`/api/admin/attendee-statuses/${status.id}`, {
          body: { confirm_identifier: "In use" },
          method: "DELETE",
        }),
        400,
        (body) => {
          expect(body.error).toBe(
            "Choose another status for its attendees before deleting",
          );
        },
      );
      expect(await getAttendeeStatus(status.id)).not.toBeNull();
    });
  });

  // Status settings are owner-only in the dashboard, so the JSON API must
  // reject managers too (a cookie-authenticated manager would otherwise reach
  // owner-gated operations through the API).
  describe("owner-only authorization", () => {
    const managerSession = async () => ({
      cookie: await createTestManagerSession(),
      csrfToken: await testCsrfToken(),
    });

    test("rejects a manager listing statuses with 403", async () => {
      const res = await handleRequest(
        requestAsSession(
          "/api/admin/attendee-statuses",
          await managerSession(),
        ),
      );
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("Forbidden");
    });

    test("rejects a manager creating a status with 403", async () => {
      const res = await handleRequest(
        requestAsSession(
          "/api/admin/attendee-statuses",
          await managerSession(),
          {
            body: JSON.stringify({ name: "Blocked" }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
        ),
      );
      expect(res.status).toBe(403);
      expect(
        (await attendeeStatuses.getAll()).some(
          (status) => status.name === "Blocked",
        ),
      ).toBe(false);
    });

    test("rejects a manager deleting a status with 403", async () => {
      const status = await createStatus("Locked");
      const res = await handleRequest(
        requestAsSession(
          `/api/admin/attendee-statuses/${status.id}`,
          await managerSession(),
          { method: "DELETE" },
        ),
      );
      expect(res.status).toBe(403);
      expect(await getAttendeeStatus(status.id)).not.toBeNull();
    });
  });

  // The CLI drives the resource off the same table as the routes, so the
  // list and create commands reach the resource with no CLI change.
  describe("CLI", () => {
    const run = (args: string[]) =>
      runApi(args, runDeps(ADMIN_API_RESOURCES, adminApiTestTransport));

    test("lists attendee statuses with their flags and amount", async () => {
      await createStatus("VIP");

      const listed = await run(["list", "attendee-statuses"]);
      const rows = JSON.parse(listed.out!)["attendee-statuses"];
      expect(rows.map((row: { name: string }) => row.name)).toEqual([
        "Confirmed",
        "VIP",
      ]);
      expect(rows[0]).toMatchObject({
        is_paid_default: true,
        is_public_default: true,
        is_reservation: false,
        name: "Confirmed",
        reservation_amount: "0",
      });
    });

    test("creates a status and lists it back", async () => {
      const created = await run([
        "create",
        "attendee-statuses",
        '{"is_reservation":true,"name":"Reserved","reservation_amount":"25%"}',
      ]);
      const status = JSON.parse(created.out!).status;
      expect(status.name).toBe("Reserved");
      expect(status.is_reservation).toBe(true);

      const listed = await run(["list", "attendee-statuses"]);
      expect(
        JSON.parse(listed.out!)["attendee-statuses"].some(
          (row: { name: string }) => row.name === "Reserved",
        ),
      ).toBe(true);
    });
  });
});
