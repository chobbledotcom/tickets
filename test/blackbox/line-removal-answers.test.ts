/** An edit that removes a booking line which holds answers. The save refuses,
 * unless the owner ticks the box that deletes those answers. Nothing is lost
 * by accident. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { requireValue } from "#shared/required-value.ts";
import {
  attendeeIds,
  attendeePage,
  book,
  openDiscos,
  textOf,
  ticketNames,
  withPupilName,
} from "#test/blackbox/discos.ts";
import type { Fields } from "#test/blackbox/driver.ts";
import { describeWithEnv } from "#test-utils/db.ts";

/** The refusal, as the page text holds it: the page escapes each quote. */
const REFUSED =
  "A listing that you removed has answers. To remove it and delete its answers, tick &quot;Delete the answers for removed listings&quot;.";

/** A parent books two places on disco A and one on disco B, with a name for
 * each. */
const bookedBoth = async () => {
  const shop = await withPupilName(await openDiscos(), undefined, "quantity");
  await book(shop, [2, 1], ticketNames(shop, ["Ava", "Amy"], ["Ben"]));
  const id = requireValue(
    (await attendeeIds(shop.api, shop.discoA))[0],
    "Disco A has no booking",
  );
  return { id, shop };
};

/** The owner sends the edit form with disco B's line at 0. */
const removeDiscoB = async (fields: Fields) => {
  const { id, shop } = await bookedBoth();
  const sent = await shop.owner.submit(
    `/admin/attendees/${id}/edit`,
    { qty1: "0", ...fields },
    `/admin/attendees/${id}`,
  );
  return { sent, shop };
};

/** An API update that keeps only disco A's line, with extra body fields. */
const updateWithoutDiscoB = async (extra: Record<string, unknown>) => {
  const { id, shop } = await bookedBoth();
  const answer = await shop.api.put(`/api/admin/attendees/${id}`, {
    lines: [{ listingId: shop.discoA.id, quantity: 2 }],
    ...extra,
  });
  return { answer, shop };
};

/** API updates that the API refuses: the extra body fields, and the reason. */
const API_REFUSALS: [string, Record<string, unknown>, string][] = [
  [
    "does not say to delete the answers",
    {},
    "A line that the update removes holds answers. Send deleteRemovedAnswers: true to remove it and delete its answers.",
  ],
  [
    "says so with a value that is not true or false",
    { deleteRemovedAnswers: "yes" },
    "deleteRemovedAnswers must be true or false",
  ],
];

describeWithEnv(
  "an edit that removes a line with answers",
  { db: true },
  () => {
    test("is refused, says why, and keeps the line and its answers", async () => {
      const { sent, shop } = await removeDiscoB({});

      expect(sent.status).toBe(200);
      expect(textOf(sent.html)).toContain(REFUSED);
      expect(await attendeePage(shop)).toContain(
        "Pupil name (Disco B, ticket 1) Ben",
      );
    });

    test("with the box ticked, removes the line and deletes its answers", async () => {
      const { sent, shop } = await removeDiscoB({
        delete_removed_answers: "1",
      });

      expect(sent.status).toBe(302);
      const page = await attendeePage(shop);
      expect(page).toContain(
        "Pupil name (Disco A, ticket 1) Ava Pupil name (Disco A, ticket 2) Amy",
      );
      expect(page).not.toContain("Ben");
    });

    test("the box does not delete the answers of a line that stays", async () => {
      const { shop } = await removeDiscoB({
        delete_removed_answers: "1",
        qty1: "1",
      });

      expect(await attendeePage(shop)).toContain(
        "Pupil name (Disco B, ticket 1) Ben",
      );
    });

    for (const [name, extra, reason] of API_REFUSALS) {
      test(`an API update that removes it and ${name} is refused`, async () => {
        const { answer, shop } = await updateWithoutDiscoB(extra);

        expect([answer.status, answer.body]).toEqual([400, { error: reason }]);
        expect(await attendeePage(shop)).toContain(
          "Pupil name (Disco B, ticket 1) Ben",
        );
      });
    }

    test("an API update with deleteRemovedAnswers removes the line and its answers", async () => {
      const { answer, shop } = await updateWithoutDiscoB({
        deleteRemovedAnswers: true,
      });

      expect(answer.status).toBe(200);
      expect(await attendeePage(shop)).not.toContain("Ben");
    });
  },
);
