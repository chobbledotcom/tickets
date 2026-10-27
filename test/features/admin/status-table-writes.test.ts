import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeeStatusApiTable } from "#db/attendee-status-api-table.ts";
import {
  attendeeStatuses,
  attendeeStatusWrites,
  statusDeleteProspects,
} from "#db/attendee-statuses.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const createStatus = async (name: string): Promise<{ id: number }> =>
  attendeeStatuses.table.insert({ name });

/** The write surface the admin JSON API writes statuses through, and the
 *  boundary refusals it raises. The routes refuse the same writes earlier, so
 *  the table's own paths are pinned here, where they live. */
describeWithEnv(
  "Attendee status write surface behind the API",
  { db: true },
  () => {
    test("the API table reads a status back by primary key", async () => {
      const status = await createStatus("Primary read");

      const read = await attendeeStatusApiTable.findByIdPrimary!(status.id);
      expect(read?.name).toBe("Primary read");
    });

    test("a partial update fills the omitted flags with the create defaults", async () => {
      const status = await createStatus("Default flags");

      const updated = await attendeeStatusApiTable.update(status.id, {
        name: "Renamed",
      });
      expect(updated?.name).toBe("Renamed");
      expect(updated?.is_paid_default).toBe(false);
      expect(updated?.is_public_default).toBe(false);
      expect(updated?.is_reservation).toBe(false);
      expect(updated?.reservation_amount).toBe("0");
    });

    test("the table update refuses a missing name", async () => {
      const status = await createStatus("Guarded");

      await expect(
        attendeeStatusApiTable.update(status.id, { isReservation: true }),
      ).rejects.toThrow("requires the name field");
    });

    // The route cannot reach these states except through a concurrent delete
    // (its own lookup answers 404 first), so the Table contract is pinned
    // here. The shared factory turns the update's null into the clean 404
    // that test/shared/rest/crud-api.test.ts pins.
    test("the table update answers null when the row is already gone", async () => {
      const status = await createStatus("Vanished");
      await attendeeStatusWrites.delete(status.id);

      await expect(
        attendeeStatusApiTable.update(status.id, { name: "Ghost" }),
      ).resolves.toBeNull();
    });

    test("the table delete of an already-gone row answers nothing", async () => {
      const status = await createStatus("Vanished twice");
      await attendeeStatusWrites.delete(status.id);

      await expect(
        attendeeStatusApiTable.deleteById(status.id),
      ).resolves.toBeUndefined();
    });

    test("the table delete throws the boundary refusal as a validation error", async () => {
      // The route pre-refuses every refusal, so the table's own throw path
      // is exercised directly: a delete the boundary refuses fails loudly.
      await createStatus("Spare");
      const [seed] = await attendeeStatuses.getAll();
      await expect(attendeeStatusApiTable.deleteById(seed!.id)).rejects.toThrow(
        "Choose another public default before deleting this status",
      );
    });

    test("the delete prospects throw for a missing status", async () => {
      await expect(statusDeleteProspects(99999)).rejects.toThrow(
        "Attendee status 99999 does not exist",
      );
    });
  },
);
