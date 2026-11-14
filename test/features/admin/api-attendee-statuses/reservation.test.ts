import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeeStatus } from "#db/attendee-statuses.ts";
import { adminApiTestTransport } from "#test-utils/admin-api-transport.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("Admin API - Attendee status zero amount", { db: true }, () => {
  test("a create that is not a reservation stores a zero amount", async () => {
    const answered = await adminApiTestTransport({
      body: { name: "Plain" },
      method: "POST",
      path: "/api/admin/attendee-statuses",
    });
    expect(answered.status).toBe(201);
    const created = (
      answered.data as { status: { id: number; reservation_amount: string } }
    ).status;
    expect(created.reservation_amount).toBe("0");
    expect((await getAttendeeStatus(created.id))?.reservation_amount).toBe("0");
  });
});
