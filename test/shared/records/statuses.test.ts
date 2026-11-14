import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { AttendeeStatusWriteInput } from "#db/attendee-statuses.ts";
import { attendeeStatuses } from "#db/attendee-statuses.ts";
import { execute, queryAll } from "#db/client.ts";
import { statusRecord, statusRule } from "#shared/records/statuses.ts";
import { RESERVATION_AMOUNT_HINT } from "#shared/reservation-amount.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import { setupListingAndAttendee } from "#test-utils/attendees/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { deleteConfirmLabel } from "#test-utils/record-labels.ts";

const statusInput = (
  name: string,
  extra: Partial<AttendeeStatusWriteInput> = {},
): AttendeeStatusWriteInput => ({
  isPaidDefault: false,
  isPublicDefault: false,
  isReservation: false,
  name,
  reservationAmount: "0",
  ...extra,
});

const PAID_RESERVATION =
  "A paid status can't also be a reservation. A paid status marks the balance as paid. A reservation holds a deposit that comes back as a bill. Only one of them can describe what the attendee owes.";

const createStatus = async (name: string): Promise<number> => {
  const created = await statusRecord.create(statusInput(name));
  if (created.kind !== "written") throw new Error("create failed");
  return created.row.id;
};

const heldStatusIds = async (): Promise<number[]> =>
  (
    await queryAll<{ status_id: number }>("SELECT status_id FROM attendees")
  ).map((row) => row.status_id);

describe("the status rule", () => {
  test("refuses a paid default that is also a reservation", () => {
    expect(
      statusRule(
        statusInput("Both", { isPaidDefault: true, isReservation: true }),
      ),
    ).toEqual({ error: PAID_RESERVATION, ok: false });
  });

  test("accepts a paid default that is not a reservation", () => {
    const input = statusInput("Paid", { isPaidDefault: true });

    expect(statusRule(input)).toEqual({ ok: true, value: input });
  });

  test("accepts a reservation that is not the paid default", () => {
    const input = statusInput("Held", {
      isReservation: true,
      reservationAmount: "10%",
    });

    expect(statusRule(input)).toEqual({ ok: true, value: input });
  });

  test("refuses a reservation with an amount it cannot read", () => {
    expect(
      statusRule(
        statusInput("Held", { isReservation: true, reservationAmount: "ten" }),
      ),
    ).toEqual({ error: RESERVATION_AMOUNT_HINT, ok: false });
  });

  test("ignores the amount of a status that is not a reservation", () => {
    const input = statusInput("Plain", { reservationAmount: "ten" });

    expect(statusRule(input)).toEqual({ ok: true, value: input });
  });
});

describe("the status record's declaration", () => {
  test("names a status on its pages and its delete page", () => {
    expect(statusRecord.activityName).toBe("Attendee status");
    expect(deleteConfirmLabel(statusRecord)).toBe("Name");
  });
});

describeWithEnv("the status record's commands", { db: true }, () => {
  test("creates a status and logs it with the status name", async () => {
    expect(await statusRecord.create(statusInput("Waiting"))).toMatchObject({
      kind: "written",
      row: { is_reservation: false, name: "Waiting" },
    });
    expect(await activityMessages()).toEqual([
      "Attendee status 'Waiting' created",
    ]);
  });

  test("refuses to create a status the rule refuses", async () => {
    expect(
      await statusRecord.create(
        statusInput("Both", { isPaidDefault: true, isReservation: true }),
      ),
    ).toEqual({ kind: "refused", message: PAID_RESERVATION });
  });

  test("updates the status it names and logs it", async () => {
    const id = await createStatus("Before");

    expect(await statusRecord.update(id, statusInput("After"))).toMatchObject({
      kind: "written",
      row: { id, name: "After" },
    });
    expect((await activityMessages())[0]).toBe(
      "Attendee status 'After' updated",
    );
  });

  test("refuses an update that clears the only paid default", async () => {
    const [confirmed] = await attendeeStatuses.getAll();
    if (confirmed === undefined) throw new Error("no default status");

    expect(
      await statusRecord.update(
        confirmed.id,
        statusInput("Confirmed", { isPublicDefault: true }),
      ),
    ).toEqual({
      kind: "refused",
      message: "Choose another paid default before clearing this one",
    });
  });

  test("answers not-found for an update of a missing status", async () => {
    expect(await statusRecord.update(999, statusInput("Gone"))).toEqual({
      kind: "not-found",
    });
  });

  test("deletes a status nothing holds and logs it", async () => {
    const id = await createStatus("Spare");

    expect(await statusRecord.remove(id)).toEqual({ kind: "deleted" });
    expect(await statusRecord.load(id)).toBe(null);
    expect((await activityMessages())[0]).toBe(
      "Attendee status 'Spare' deleted",
    );
  });

  test("answers not-found for a delete of a missing status", async () => {
    expect(await statusRecord.remove(999)).toEqual({ kind: "not-found" });
  });

  test("moves the attendees to the status a delete names", async () => {
    const { attendee } = await setupListingAndAttendee();
    const [confirmed] = await attendeeStatuses.getAll();
    if (confirmed === undefined) throw new Error("no default status");
    const id = await createStatus("Retiring");
    await execute("UPDATE attendees SET status_id = ? WHERE id = ?", [
      id,
      attendee.id,
    ]);

    expect(await statusRecord.remove(id, "not a status id")).toEqual({
      kind: "refused",
      message: "Choose another status for its attendees before deleting",
    });
    expect(await statusRecord.remove(id, confirmed.id)).toEqual({
      kind: "deleted",
    });
    expect(await heldStatusIds()).toEqual([confirmed.id]);
  });
});
