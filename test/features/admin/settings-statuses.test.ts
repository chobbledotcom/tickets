/**
 * The attendee-statuses area: its CRUD routes and the ordering controls that
 * sit beside them. The integration suite drives the same routes through the
 * server; this is the mirror the mutation gate runs against.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeeStatuses } from "#db/attendee-statuses.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

const PATH = "/admin/settings/statuses";

const createStatus = async (name: string): Promise<number> => {
  await adminFormPost(PATH, { name });
  const all = await attendeeStatuses.getAll();
  return all.find((status) => status.name === name)!.id;
};

describeWithEnv("attendee statuses", { db: true }, () => {
  test("returns a new status to the list, not to its own page", async () => {
    // A status is short enough to create several in a row, so creating one
    // leaves the operator where they can create the next.
    const { response } = await adminFormPost(PATH, { name: "Waiting" });

    await expectFlashRedirect(PATH, "Status created")(response);
    expect(await (await adminGet(PATH)).text()).toContain("Waiting");
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

    expect(html).toContain("Name");
    expect(html).toContain("Spare");
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
});
