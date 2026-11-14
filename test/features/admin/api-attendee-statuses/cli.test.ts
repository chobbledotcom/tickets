import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { runApi } from "#cli/run.ts";
import { attendeeStatuses } from "#db/attendee-statuses.ts";
import { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import { adminApiTestTransport } from "#test-utils/admin-api-transport.ts";
import { runDeps } from "#test-utils/cli-table.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const createStatus = async (name: string): Promise<void> => {
  await attendeeStatuses.table.insert({ name });
};

/** The CLI drives the resource off the same table as the routes, so the list
 *  and create commands reach the resource with no CLI change. */
describeWithEnv("CLI attendee statuses", { db: true }, () => {
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
