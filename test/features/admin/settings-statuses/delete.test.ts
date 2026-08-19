/**
 * Deleting an attendee status, and the four reasons it is refused.
 *
 * A status the site depends on cannot go: the last one, either default, and
 * one an attendee is currently on.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeeStatuses } from "#shared/db/attendee-statuses.ts";
import { execute } from "#shared/db/client.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { setupListingAndAttendee } from "#test-utils/attendees/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

const PATH = "/admin/settings/statuses";

const create = async (
  name: string,
  extra: Record<string, string> = {},
): Promise<number> => {
  await adminFormPost(PATH, { name, ...extra });
  return (await attendeeStatuses.getAll()).find((one) => one.name === name)!.id;
};

const remove = (id: number, name: string) =>
  adminFormPost(`${PATH}/${id}/delete`, { confirm_identifier: name });

const names = async (): Promise<string[]> =>
  (await attendeeStatuses.getAll()).map((one) => one.name);

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
      "This status is in use by attendees",
      false,
    )(response);
    expect(await names()).toContain("In Use");
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
