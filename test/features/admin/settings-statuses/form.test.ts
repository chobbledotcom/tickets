/**
 * What the attendee-status form accepts, and what each refusal says.
 *
 * A status can be the one new public bookings get, the one a paid booking
 * gets, or a reservation that takes a deposit. The last two are opposites, so
 * a status cannot be both.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeeStatuses } from "#shared/db/attendee-statuses.ts";
import { RESERVATION_AMOUNT_HINT } from "#shared/reservation-amount.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { adminFormPost } from "#test-utils/session.ts";

const PATH = "/admin/settings/statuses";

const create = (fields: Record<string, string>) => adminFormPost(PATH, fields);

const storedByName = async (name: string) =>
  (await attendeeStatuses.getAll()).find((one) => one.name === name);

describeWithEnv("what a new status may say", { db: true }, () => {
  test("takes a plain name and stores it as neither default", async () => {
    await create({ name: "Plain" });

    expect(await storedByName("Plain")).toMatchObject({
      is_paid_default: false,
      is_public_default: false,
      is_reservation: false,
      reservation_amount: "0",
    });
  });

  test("stores the two defaults when the operator ticks them", async () => {
    await create({
      is_paid_default: "1",
      is_public_default: "1",
      name: "Both Defaults",
    });

    expect(await storedByName("Both Defaults")).toMatchObject({
      is_paid_default: true,
      is_public_default: true,
    });
  });

  test("stores a reservation's deposit", async () => {
    await create({
      is_reservation: "1",
      name: "Deposit",
      reservation_amount: "10%",
    });

    expect(await storedByName("Deposit")).toMatchObject({
      is_reservation: true,
      reservation_amount: "10%",
    });
  });

  test("ignores a deposit typed on a status that takes none", async () => {
    await create({ name: "Not A Reservation", reservation_amount: "25" });

    expect(await storedByName("Not A Reservation")).toMatchObject({
      is_reservation: false,
      reservation_amount: "0",
    });
  });
});

describeWithEnv("what a new status may not say", { db: true }, () => {
  const expectRefused = async (
    fields: Record<string, string>,
    reason: string,
  ): Promise<void> => {
    const before = (await attendeeStatuses.getAll()).length;
    const { response } = await create(fields);

    await expectFlashRedirect(`${PATH}/new`, reason, false)(response);
    expect((await attendeeStatuses.getAll()).length).toBe(before);
  };

  test("refuses one with no name", () =>
    expectRefused({ name: "" }, "Please enter a name"));

  test("refuses one that is both a reservation and the paid default", () =>
    expectRefused(
      { is_paid_default: "1", is_reservation: "1", name: "Contradiction" },
      "A paid status can't also be a reservation",
    ));

  test("refuses a deposit it cannot read", () =>
    expectRefused(
      { is_reservation: "1", name: "Vague", reservation_amount: "some" },
      RESERVATION_AMOUNT_HINT,
    ));
});

describeWithEnv("clearing a default", { db: true }, () => {
  /** The status a fresh site starts with, which holds both defaults. */
  const theOnlyStatus = async () => (await attendeeStatuses.getAll())[0]!;

  /** Save the only status with one default ticked, dropping the other. The
   * form comes straight back at 400 with the reason on it. */
  const dropOneDefault = async (keep: string): Promise<string> => {
    const status = await theOnlyStatus();
    const { response } = await adminFormPost(`${PATH}/${status.id}/edit`, {
      [keep]: "1",
      name: status.name,
    });

    expect(response.status).toBe(400);
    return await response.text();
  };

  test("refuses to leave the site with no public default", async () => {
    expect(await dropOneDefault("is_paid_default")).toContain(
      "Choose another public default before clearing this one",
    );
  });

  test("refuses to leave the site with no paid default", async () => {
    expect(await dropOneDefault("is_public_default")).toContain(
      "Choose another paid default before clearing this one",
    );
  });
});
