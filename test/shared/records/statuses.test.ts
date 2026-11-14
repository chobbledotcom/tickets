import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeeStatuses } from "#db/attendee-statuses.ts";
import { execute, queryAll } from "#db/client.ts";
import { statusRecord, statusRule } from "#shared/records/statuses.ts";
import { RESERVATION_AMOUNT_HINT } from "#shared/reservation-amount.ts";
import { setupListingAndAttendee } from "#test-utils/attendees/helpers.ts";
import { statusInput } from "#test-utils/db-helpers/attendee-statuses.ts";
import {
  expectCreateThenDelete,
  expectRefused,
  expectWrittenAndLogged,
  testMissingUpdate,
  writtenRow,
} from "#test-utils/record-commands.ts";
import { describeRecord } from "#test-utils/record-labels.ts";
import { describeRuleCases } from "#test-utils/rule-cases.ts";

const PAID_RESERVATION =
  "A paid status can't also be a reservation. A paid status marks the balance as paid. A reservation holds a deposit that comes back as a bill. Only one of them can describe what the attendee owes.";

const createStatus = async (name: string) =>
  (await writtenRow(statusRecord.create(statusInput(name)))).id;

const heldStatusIds = async (): Promise<number[]> =>
  (
    await queryAll<{ status_id: number }>("SELECT status_id FROM attendees")
  ).map((row) => row.status_id);

describeRuleCases("the status rule", statusRule, [
  [
    "refuses a paid default that is also a reservation",
    statusInput("Both", { isPaidDefault: true, isReservation: true }),
    PAID_RESERVATION,
  ],
  [
    "accepts a paid default that is not a reservation",
    statusInput("Paid", { isPaidDefault: true }),
    null,
  ],
  [
    "accepts a reservation that is not the paid default",
    statusInput("Held", { isReservation: true, reservationAmount: "10%" }),
    null,
  ],
  [
    "refuses a reservation with an amount it cannot read",
    statusInput("Held", { isReservation: true, reservationAmount: "ten" }),
    RESERVATION_AMOUNT_HINT,
  ],
  [
    "ignores the amount of a status that is not a reservation",
    statusInput("Plain", { reservationAmount: "ten" }),
    null,
  ],
]);

describeRecord(statusRecord, "Attendee status", "Name", () => {
  test("creates a status and logs it with the status name", async () => {
    await expectWrittenAndLogged(
      statusRecord.create(statusInput("Waiting")),
      { is_reservation: false, name: "Waiting" },
      ["Attendee status 'Waiting' created"],
    );
  });

  test("refuses to create a status the rule refuses", async () => {
    await expectRefused(
      statusRecord.create(
        statusInput("Both", { isPaidDefault: true, isReservation: true }),
      ),
      PAID_RESERVATION,
    );
  });

  test("updates the status it names and logs it", async () => {
    const id = await createStatus("Before");

    await expectWrittenAndLogged(
      statusRecord.update(id, statusInput("After")),
      { id, name: "After" },
      ["Attendee status 'After' updated", "Attendee status 'Before' created"],
    );
  });

  test("refuses an update that clears the only paid default", async () => {
    const [confirmed] = await attendeeStatuses.getAll();
    if (confirmed === undefined) throw new Error("no default status");

    await expectRefused(
      statusRecord.update(
        confirmed.id,
        statusInput("Confirmed", { isPublicDefault: true }),
      ),
      "Choose another paid default before clearing this one",
    );
  });

  testMissingUpdate(statusRecord, statusInput("Gone"));

  test("deletes a status nothing holds and logs it", async () => {
    await expectCreateThenDelete(statusRecord, statusInput("Spare"), [
      "Attendee status 'Spare' deleted",
      "Attendee status 'Spare' created",
    ]);
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

    await expectRefused(
      statusRecord.remove(id, "not a status id"),
      "Choose another status for its attendees before deleting",
    );
    expect(await statusRecord.remove(id, confirmed.id)).toEqual({
      kind: "deleted",
    });
    expect(await heldStatusIds()).toEqual([confirmed.id]);
  });
});
