import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeeStatuses, getAttendeeStatus } from "#db/attendee-statuses.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { apiRequest } from "#test-utils/session.ts";

describeWithEnv(
  "Admin API - Attendee statuses - reservation turned off",
  { db: true },
  () => {
    test("turning the reservation off stores a zero amount", async () => {
      const status = await attendeeStatuses.table.insert({
        isReservation: true,
        name: "Held",
        reservationAmount: "25%",
      });

      await assertJson(
        apiRequest(`/api/admin/attendee-statuses/${status.id}`, {
          body: { is_reservation: false },
          method: "PUT",
        }),
        200,
        (body) => {
          expect(body.status.is_reservation).toBe(false);
          expect(body.status.reservation_amount).toBe("0");
        },
      );
      const stored = await getAttendeeStatus(status.id);
      expect(stored?.reservation_amount).toBe("0");
    });

    test("a plain create stores a zero amount", async () => {
      const created = await assertJson(
        apiRequest("/api/admin/attendee-statuses", {
          body: { name: "Plain" },
          method: "POST",
        }),
        201,
      );
      const stored = await getAttendeeStatus(created.status.id as number);
      expect(stored?.reservation_amount).toBe("0");
    });
  },
);
