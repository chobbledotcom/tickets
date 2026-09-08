/**
 * Deleting an attendee status, and the four reasons it is refused.
 *
 * A status the site depends on cannot go: the last one, either default, and
 * one an attendee is currently on.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  attendeeStatuses,
  attendeeStatusWrites,
} from "#db/attendee-statuses.ts";
import { execute } from "#db/client.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { setupListingAndAttendee } from "#test-utils/attendees/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withDbFault } from "#test-utils/db-fault.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

const PATH = "/admin/settings/statuses";

const create = async (
  name: string,
  extra: Record<string, string> = {},
): Promise<number> => {
  await adminFormPost(PATH, { name, ...extra });
  return (await attendeeStatuses.getAll()).find((one) => one.name === name)!.id;
};

const remove = (id: number, name: string, extra: Record<string, string> = {}) =>
  adminFormPost(`${PATH}/${id}/delete`, { confirm_identifier: name, ...extra });

const names = async (): Promise<string[]> =>
  (await attendeeStatuses.getAll()).map((one) => one.name);

const attendeeStatusCount = async (statusId: number): Promise<number> => {
  const rows = await execute(
    "SELECT COUNT(*) AS held FROM attendees WHERE status_id = ?",
    [statusId],
  );
  return Number(rows.rows[0]!.held);
};

describeWithEnv("deleting a status", { db: true }, () => {
  test("removes one nothing depends on", async () => {
    const id = await create("Spare");

    const { response } = await remove(id, "Spare");

    await expectFlashRedirect(PATH, "Status deleted")(response);
    expect(await names()).not.toContain("Spare");
  });

  test("writes the removal to the activity log by its full name", async () => {
    // The log says "Attendee status", not the shorter word the page uses, so
    // an entry read months later is not mistaken for a listing's status.
    const id = await create("Logged Removal");

    await remove(id, "Logged Removal");

    expect(await activityMessages()).toContain(
      "Attendee status 'Logged Removal' deleted",
    );
  });

  test("refuses the last one left", async () => {
    const only = (await attendeeStatuses.getAll())[0]!;

    const { response } = await remove(only.id, only.name);

    await expectFlashRedirect(
      `${PATH}/${only.id}/delete`,
      "You must keep at least one status",
      false,
    )(response);
    expect(await names()).toContain(only.name);
  });

  test("refuses the one new public bookings get", async () => {
    const only = (await attendeeStatuses.getAll())[0]!;
    await create("Somewhere Else To Go");

    const { response } = await remove(only.id, only.name);

    await expectFlashRedirect(
      `${PATH}/${only.id}/delete`,
      "Choose another public default before deleting this status",
      false,
    )(response);
  });

  test("refuses the one a paid booking gets", async () => {
    const only = (await attendeeStatuses.getAll())[0]!;
    const spare = await create("Public Instead", { is_public_default: "1" });
    expect(spare).toBeGreaterThan(0);

    const { response } = await remove(only.id, only.name);

    await expectFlashRedirect(
      `${PATH}/${only.id}/delete`,
      "Choose another paid default before deleting this status",
      false,
    )(response);
  });

  test("refuses one an attendee is currently on", async () => {
    const { attendee } = await setupListingAndAttendee({ name: "On It" });
    const id = await create("In Use");
    await execute("UPDATE attendees SET status_id = ? WHERE id = ?", [
      id,
      attendee.id,
    ]);

    const { response } = await remove(id, "In Use");

    await expectFlashRedirect(
      `${PATH}/${id}/delete`,
      "Choose another status for its attendees before deleting",
      false,
    )(response);
    expect(await names()).toContain("In Use");
    expect(await attendeeStatusCount(id)).toBe(1);
  });
});

describeWithEnv("the delete confirmation", { db: true }, () => {
  test("asks the operator to type the status name", async () => {
    const id = await create("Type Me");

    const html = await (await adminGet(`${PATH}/${id}/delete`)).text();

    expect(html).toContain("Name");
    expect(html).toContain("Type Me");
  });

  test("refuses a name that does not match", async () => {
    const id = await create("Exact");

    const { response } = await remove(id, "Not Exact");

    await expectFlashRedirect(
      `${PATH}/${id}/delete`,
      "Name does not match. Please type the exact name to confirm deletion.",
      false,
    )(response);
    expect(await names()).toContain("Exact");
  });
});

describeWithEnv("retiring a status attendees hold", { db: true }, () => {
  /** One attendee sitting on a fresh `Busy` status, with one other status
   *  to move to. */
  const arrangeBusy = async (): Promise<{
    busyId: number;
    attendeeId: number;
    otherId: number;
  }> => {
    const otherId = await create("Landing Status");
    const busyId = await create("Busy");
    const { attendee } = await setupListingAndAttendee({ name: "Holder" });
    await execute("UPDATE attendees SET status_id = ? WHERE id = ?", [
      busyId,
      attendee.id,
    ]);
    return { attendeeId: attendee.id, busyId, otherId };
  };

  test("the delete page shows the count and a required picker of other statuses", async () => {
    const { busyId } = await arrangeBusy();

    const html = await (await adminGet(`${PATH}/${busyId}/delete`)).text();

    expect(html).toContain("Busy");
    expect(html).toContain("1 attendee");
    expect(html).toContain('name="reassign_status_id"');
    expect(html).toContain("Landing Status");
  });

  test("the picker is absent from a free status's delete page", async () => {
    const id = await create("Free To Go");

    const html = await (await adminGet(`${PATH}/${id}/delete`)).text();

    expect(html).not.toContain('name="reassign_status_id"');
  });

  test("moves its attendees to the chosen status, then deletes the status", async () => {
    const { attendeeId, busyId, otherId } = await arrangeBusy();

    const { response } = await remove(busyId, "Busy", {
      reassign_status_id: String(otherId),
    });

    await expectFlashRedirect(PATH, "Status deleted")(response);
    const rows = await execute("SELECT status_id FROM attendees WHERE id = ?", [
      attendeeId,
    ]);
    expect(Number(rows.rows[0]!.status_id)).toBe(otherId);
    expect(await names()).toContain("Landing Status");
    expect(await names()).not.toContain("Busy");
    expect(await activityMessages()).toContain(
      "1 attendee(s) moved from status 'Busy' to 'Landing Status'",
    );
  });

  test("a missing target status refuses the delete and keeps everything", async () => {
    const { busyId } = await arrangeBusy();

    const { response } = await remove(busyId, "Busy", {
      reassign_status_id: "999999",
    });

    await expectFlashRedirect(
      `${PATH}/${busyId}/delete`,
      "Choose another status for its attendees before deleting",
      false,
    )(response);
    expect(await names()).toContain("Busy");
    expect(await attendeeStatusCount(busyId)).toBe(1);
  });

  test("a failed reassign rolls the whole delete back", async () => {
    const { attendeeId, busyId, otherId } = await arrangeBusy();
    const faultName = "test_status_reassign_fault";

    const fault = withDbFault(
      `CREATE TRIGGER ${faultName}
         BEFORE UPDATE ON attendees
         WHEN NEW.status_id = ${otherId}
       BEGIN SELECT RAISE(ABORT, 'reassign unavailable'); END`,
      faultName,
      () => attendeeStatusWrites.delete(busyId, otherId),
    );
    await expect(fault).rejects.toThrow("reassign unavailable");

    expect(await names()).toContain("Busy");
    expect(await attendeeStatusCount(busyId)).toBe(1);
    const rows = await execute("SELECT status_id FROM attendees WHERE id = ?", [
      attendeeId,
    ]);
    expect(Number(rows.rows[0]!.status_id)).toBe(busyId);
  });
});
