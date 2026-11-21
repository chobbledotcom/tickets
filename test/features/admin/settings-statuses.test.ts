/**
 * The attendee-statuses area: its CRUD routes and the ordering controls that
 * sit beside them. The integration suite drives the same routes through the
 * server; this is the mirror the mutation gate runs against.
 */

import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attendeeStatuses } from "#db/attendee-statuses.ts";
import {
  expectFlashRedirect,
  expectIncludesAll,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";
import { arrangeBusy, create, statusIdOf } from "./settings-statuses/held.ts";

const PATH = "/admin/settings/statuses";

describeWithEnv("attendee statuses", { db: true }, () => {
  test("returns a new status to the list, not to its own page", async () => {
    // A status is short enough to create several in a row, so creating one
    // leaves the operator where they can create the next.
    const { response } = await adminFormPost(PATH, { name: "Waiting" });

    await expectFlashRedirect(PATH, "Status created")(response);
    assertStringIncludes(await (await adminGet(PATH)).text(), "Waiting");
  });

  test("sends the operator to the status's own page after an edit", async () => {
    const id = await create("Rename Me");

    const { response } = await adminFormPost(`${PATH}/${id}/edit`, {
      name: "Renamed",
    });

    await expectFlashRedirect(`${PATH}/${id}`, "Status updated")(response);
  });

  test("names the field an operator must type to delete", async () => {
    const id = await create("Spare");

    const html = await (await adminGet(`${PATH}/${id}/delete`)).text();

    expectIncludesAll(html, ["Name", "Spare"]);
  });

  describe("moving a status", () => {
    /** Three statuses in a known order: the seeded first status, then two
     *  more. */
    const threeStatuses = async () => {
      const first = (await attendeeStatuses.getAll())[0]!;
      const second = await create("Second");
      const third = await create("Third");
      return { first: first.id, second, third };
    };

    const names = async (): Promise<string[]> =>
      (await attendeeStatuses.getAll()).map((one) => one.name);

    const move = async (id: number, place: string, anchor: string) =>
      (await adminFormPost(`${PATH}/${id}/move-${place}`, { anchor })).response;

    test("the down arrow moves a status after the next one", async () => {
      const { first, second } = await threeStatuses();
      const [firstName] = await names();

      await expectFlashRedirect(
        PATH,
        "Status moved",
      )(await move(first, "after", String(second)));

      expect(await names()).toEqual(["Second", firstName, "Third"]);
    });

    test("the up arrow moves a status before the one above", async () => {
      const { second, third } = await threeStatuses();
      const [firstName] = await names();

      await move(third, "before", String(second));

      expect(await names()).toEqual([firstName, "Third", "Second"]);
    });

    test("a drop moves a status several places at once", async () => {
      const { first, third } = await threeStatuses();
      const [firstName] = await names();

      await move(third, "before", String(first));

      expect(await names()).toEqual(["Third", firstName, "Second"]);
    });

    test("the same move twice gives the same order", async () => {
      const { first, third } = await threeStatuses();
      await move(third, "before", String(first));
      const once = await names();

      await move(third, "before", String(first));

      expect(await names()).toEqual(once);
    });

    for (const [title, anchorOf] of [
      ["a status that is gone", () => "99999"],
      ["the status itself", (id: number) => String(id)],
    ] as const) {
      test(`an anchor naming ${title} changes nothing`, async () => {
        const { second } = await threeStatuses();
        const order = await names();

        await expectFlashRedirect(
          PATH,
          "That list changed since you opened it. Please try the move again.",
          false,
        )(await move(second, "after", anchorOf(second)));

        expect(await names()).toEqual(order);
      });
    }

    test("answers 404 moving a status that is not there", async () => {
      const response = await move(99999, "before", "1");

      expect(response.status).toBe(404);
    });
  });

  describe("the status form", () => {
    const storedByName = async (name: string) =>
      (await attendeeStatuses.getAll()).find((one) => one.name === name);

    for (const { fields, name, stored, status } of [
      {
        fields: { reservationAmount: "25" },
        name: "stores a plain name as neither default and no deposit",
        status: "Plain",
        stored: {
          isPaidDefault: false,
          isPublicDefault: false,
          isReservation: false,
          reservationAmount: "0",
        },
      },
      {
        fields: { isPaidDefault: "1", isPublicDefault: "1" },
        name: "stores the two defaults the operator ticks",
        status: "Both Defaults",
        stored: { isPaidDefault: true, isPublicDefault: true },
      },
      {
        fields: { isReservation: "1", reservationAmount: "10%" },
        name: "stores a reservation's deposit",
        status: "Deposit",
        stored: { isReservation: true, reservationAmount: "10%" },
      },
    ]) {
      test(name, async () => {
        await create(status, fields);

        expect(await storedByName(status)).toMatchObject(stored);
      });
    }

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
    test("shows the count and a picker only when one attendee holds it", async () => {
      const { busyId } = await arrangeBusy();
      const freeId = await create("Free To Go");

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
      expect(await statusIdOf(attendeeId)).toBe(otherId);
      const names = (await attendeeStatuses.getAll()).map((one) => one.name);
      expect(names).not.toContain("Busy");
    });
  });
});
