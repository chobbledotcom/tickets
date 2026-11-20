/**
 * The attendee-statuses area: its CRUD routes and the ordering controls that
 * sit beside them. The integration suite drives the same routes through the
 * server; this is the mirror the mutation gate runs against.
 */

import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attendeeStatuses } from "#db/attendee-statuses.ts";
import { execute } from "#db/client.ts";
import { sql } from "#db/sql.ts";
import {
  expectFlashRedirect,
  expectIncludesAll,
} from "#test-utils/assertions.ts";
import { setupListingAndAttendee } from "#test-utils/attendees/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

const PATH = "/admin/settings/statuses";

const createStatus = async (
  name: string,
  extra: Record<string, string> = {},
): Promise<number> => {
  await adminFormPost(PATH, { name, ...extra });
  const all = await attendeeStatuses.getAll();
  return all.find((status) => status.name === name)!.id;
};

describeWithEnv("attendee statuses", { db: true }, () => {
  test("returns a new status to the list, not to its own page", async () => {
    // A status is short enough to create several in a row, so creating one
    // leaves the operator where they can create the next.
    const { response } = await adminFormPost(PATH, { name: "Waiting" });

    await expectFlashRedirect(PATH, "Status created")(response);
    assertStringIncludes(await (await adminGet(PATH)).text(), "Waiting");
  });

  test("sends the operator to the status's own page after an edit", async () => {
    const id = await createStatus("Rename Me");

    const { response } = await adminFormPost(`${PATH}/${id}/edit`, {
      name: "Renamed",
    });

    await expectFlashRedirect(`${PATH}/${id}`, "Status updated")(response);
  });

  test("names the field an operator must type to delete", async () => {
    const id = await createStatus("Spare");

    const html = await (await adminGet(`${PATH}/${id}/delete`)).text();

    expectIncludesAll(html, ["Name", "Spare"]);
  });

  test("moves a status down, and the list shows the new order", async () => {
    const first = (await attendeeStatuses.getAll())[0]!;
    await createStatus("Second");

    const { response } = await adminFormPost(
      `${PATH}/${first.id}/move-down`,
      {},
    );

    await expectFlashRedirect(PATH, "Status moved")(response);
    const order = (await attendeeStatuses.getAll()).map((one) => one.name);
    expect(order[0]).toBe("Second");
  });

  test("answers 404 moving a status that is not there", async () => {
    const { response } = await adminFormPost(`${PATH}/99999/move-up`, {});

    expect(response.status).toBe(404);
  });

  describe("the status form", () => {
    const storedByName = async (name: string) =>
      (await attendeeStatuses.getAll()).find((one) => one.name === name);

    test("stores a plain name as neither default and no deposit", async () => {
      await createStatus("Plain", { reservationAmount: "25" });

      expect(await storedByName("Plain")).toMatchObject({
        isPaidDefault: false,
        isPublicDefault: false,
        isReservation: false,
        reservationAmount: "0",
      });
    });

    test("stores the two defaults the operator ticks", async () => {
      await createStatus("Both Defaults", {
        isPaidDefault: "1",
        isPublicDefault: "1",
      });

      expect(await storedByName("Both Defaults")).toMatchObject({
        isPaidDefault: true,
        isPublicDefault: true,
      });
    });

    test("stores a reservation's deposit", async () => {
      await createStatus("Deposit", {
        isReservation: "1",
        reservationAmount: "10%",
      });

      expect(await storedByName("Deposit")).toMatchObject({
        isReservation: true,
        reservationAmount: "10%",
      });
    });

    test("refuses a status with no name", async () => {
      const { response } = await adminFormPost(PATH, { name: "" });

      await expectFlashRedirect(
        `${PATH}/new`,
        "Please enter a name",
        false,
      )(response);
    });
  });

  describe("deleting a status attendees hold", () => {
    const arrangeBusy = async () => {
      const otherId = await createStatus("Landing Status");
      const busyId = await createStatus("Busy");
      const { attendee } = await setupListingAndAttendee({ name: "Holder" });
      await execute(
        sql`UPDATE attendees SET status_id = ${busyId} WHERE id = ${attendee.id}`,
      );
      return { attendeeId: attendee.id, busyId, otherId };
    };

    test("shows the count and a picker only when one attendee holds it", async () => {
      const { busyId } = await arrangeBusy();
      const freeId = await createStatus("Free To Go");

      const busy = await (await adminGet(`${PATH}/${busyId}/delete`)).text();
      const free = await (await adminGet(`${PATH}/${freeId}/delete`)).text();

      expectIncludesAll(busy, [
        "1 attendee holds this status.",
        'name="reassignStatusId"',
        "Landing Status",
      ]);
      expect(free).not.toContain('name="reassignStatusId"');
    });

    test("moves its attendees to the chosen status, then deletes it", async () => {
      const { attendeeId, busyId, otherId } = await arrangeBusy();

      const { response } = await adminFormPost(`${PATH}/${busyId}/delete`, {
        confirmIdentifier: "Busy",
        reassignStatusId: String(otherId),
      });

      await expectFlashRedirect(PATH, "Status deleted")(response);
      const rows = await execute(
        sql`SELECT status_id FROM attendees WHERE id = ${attendeeId}`,
      );
      expect(Number(rows.rows[0]!.status_id)).toBe(otherId);
      const names = (await attendeeStatuses.getAll()).map((one) => one.name);
      expect(names).not.toContain("Busy");
    });
  });
});
