/** The warnings about one attendee. They show above the tabs of the attendee
 * page, on every tab, and the operator cannot dismiss them. A warning goes
 * away only when the booking no longer needs it. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { requireValue } from "#shared/required-value.ts";
import {
  attendeeIds,
  book,
  type Discos,
  openDiscos,
  textOf,
  ticketNames,
  withPupilName,
} from "#test/blackbox/discos.ts";
import { describeWithEnv } from "#test-utils/db.ts";

/** The words of the warning about hidden answers. */
const hidden = (count: number) =>
  `${count === 1 ? "1 answer is for a ticket that is" : `${count} answers are for tickets that are`} no longer booked. Raise the quantity to show them again, or delete them.`;

/** Words that any warning about hidden answers holds. */
const HIDDEN = "no longer booked. Raise the quantity";

type Shop = Discos & { readonly question: number };

/** A parent books three places on disco A, and types a name for each. */
const bookedThree = async (): Promise<Shop & { id: number }> => {
  const shop = await withPupilName(await openDiscos(), undefined, "quantity");
  await book(shop, [3, 0], ticketNames(shop, ["Ava", "Amy", "Abe"]));
  const [id] = await attendeeIds(shop.api, shop.discoA);
  return { ...shop, id: requireValue(id, "Disco A has no booking") };
};

/** The owner sets the quantity of the booking's only line. */
const setQuantity = (shop: Shop & { id: number }, quantity: number) =>
  shop.owner.submit(
    `/admin/attendees/${shop.id}/edit`,
    { qty0: String(quantity) },
    `/admin/attendees/${shop.id}`,
  );

/** The text of one tab of the attendee page. */
const tabText = async (shop: Shop & { id: number }, tab = "") =>
  textOf((await shop.owner.get(`/admin/attendees/${shop.id}${tab}`)).html);

const deletePath = (id: number) =>
  `/admin/attendees/${id}/delete-hidden-answers`;

/** The answers that the delete page offers to delete. */
const offeredIds = async (shop: Shop & { id: number }): Promise<string> => {
  const page = await shop.owner.get(deletePath(shop.id));
  return requireValue(
    page.html.match(/name="answer_ids"[^>]*value="([^"]*)"/)?.[1],
    "The delete page offers no answers",
  );
};

/** The owner confirms the delete page. `answerIds` replaces the answers that
 * the page offers, as a page opened earlier sends them. */
const confirmDelete = (shop: Shop & { id: number }, answerIds?: string) =>
  shop.owner.submit(deletePath(shop.id), {
    confirmIdentifier: "PTA Parent",
    ...(answerIds === undefined ? {} : { answer_ids: answerIds }),
  });

/** A delete page opened at one quantity, and sent after the owner sets
 * another: what the attendee page still shows, and what is gone. */
const STALE_DELETES: [string, number, number, string, string][] = [
  [
    "an answer that is booked again",
    1,
    2,
    "Answers for each listing Pupil name (Disco A, ticket 1) Ava Pupil name (Disco A, ticket 2) Amy",
    "Abe",
  ],
  [
    "an answer that was hidden after the page opened",
    2,
    1,
    `${hidden(1)} Pupil name (Disco A, ticket 2) Amy Delete these answers`,
    "Abe",
  ],
];

/** The lists of attendees that sum up their warnings, and their paths. */
const LIST_PAGES: [string, (shop: Shop) => string][] = [
  ["the attendees page", () => "/admin/attendees"],
  [
    "a listing's attendees tab",
    (shop) => `/admin/listing/${shop.discoA.id}/attendees`,
  ],
];

describeWithEnv("the warnings about an attendee", { db: true }, () => {
  test("an answer for a ticket that the booking no longer takes shows in a warning on every tab", async () => {
    const shop = await bookedThree();

    await setQuantity(shop, 2);

    const warning = `Warning ${hidden(1)} Pupil name (Disco A, ticket 3) Abe Delete these answers`;
    expect(await tabText(shop)).toContain(warning);
    expect(await tabText(shop, "/edit")).toContain(warning);
    expect(await tabText(shop, "/actions")).toContain(warning);
  });

  test("the answers table shows only the answers of booked tickets", async () => {
    const shop = await bookedThree();

    await setQuantity(shop, 1);

    const page = await tabText(shop);
    expect(page).toContain(
      "Answers for each listing Pupil name (Disco A, ticket 1) Ava",
    );
    expect(page.split("Answers for each listing")[1]).not.toContain("Amy");
  });

  test("a booking whose answers are all booked shows no warning", async () => {
    const shop = await bookedThree();

    expect(await tabText(shop)).not.toContain(HIDDEN);
  });

  test("raising the quantity again shows the answers and clears the warning", async () => {
    const shop = await bookedThree();
    await setQuantity(shop, 1);

    await setQuantity(shop, 3);

    const page = await tabText(shop);
    expect(page).not.toContain(HIDDEN);
    expect(page).toContain(
      "Pupil name (Disco A, ticket 2) Amy Pupil name (Disco A, ticket 3) Abe",
    );
  });

  test("the owner deletes the hidden answers, and raising the quantity shows no answer for those tickets", async () => {
    const shop = await bookedThree();
    await setQuantity(shop, 1);

    const sent = await confirmDelete(shop);
    await setQuantity(shop, 3);

    expect([sent.status, sent.location?.split("?")[0]]).toEqual([
      302,
      `/admin/attendees/${shop.id}`,
    ]);
    const page = await tabText(shop);
    expect(page).not.toContain(HIDDEN);
    expect(page).not.toContain("Amy");
    expect(page).not.toContain("Abe");
  });

  for (const [name, opened, then, kept, gone] of STALE_DELETES) {
    test(`a delete from a page opened earlier keeps ${name}`, async () => {
      const shop = await bookedThree();
      await setQuantity(shop, opened);
      const answerIds = await offeredIds(shop);

      await setQuantity(shop, then);
      await confirmDelete(shop, answerIds);

      const page = await tabText(shop);
      expect(page).toContain(kept);
      expect(page).not.toContain(gone);
    });
  }

  test("a delete whose answers are all booked again says nothing was deleted and logs no delete", async () => {
    const shop = await bookedThree();
    await setQuantity(shop, 1);
    const [bookedAgain] = (await offeredIds(shop)).split(",");
    await setQuantity(shop, 2);

    const sent = await confirmDelete(shop, bookedAgain);
    const page = await shop.owner.get(
      requireValue(sent.location, "The delete sent the owner nowhere"),
    );
    const log = await shop.owner.get("/admin/log");

    expect(textOf(page.html)).toContain(
      "These answers are no longer hidden. Nothing was deleted.",
    );
    expect(textOf(page.html)).not.toContain("Hidden answers deleted.");
    expect(textOf(log.html)).not.toContain("Hidden answers deleted");
  });

  test("the delete page of a booking with no hidden answers says so and offers no form", async () => {
    const shop = await bookedThree();

    const page = await shop.owner.get(deletePath(shop.id));

    expect(page.status).toBe(400);
    expect(textOf(page.html)).toContain(
      "This booking has no hidden answers to delete.",
    );
    expect(page.html).not.toContain('name="answer_ids"');
  });

  test("a delete that names a wrong attendee name deletes nothing", async () => {
    const shop = await bookedThree();
    await setQuantity(shop, 1);

    await shop.owner.submit(deletePath(shop.id), {
      confirmIdentifier: "Someone else",
    });

    expect(await tabText(shop)).toContain(
      `${hidden(2)} Pupil name (Disco A, ticket 2) Amy Pupil name (Disco A, ticket 3) Abe`,
    );
  });

  test("a delete whose answer list is not a list of answers deletes nothing and says so", async () => {
    const shop = await bookedThree();
    await setQuantity(shop, 1);

    const sent = await confirmDelete(shop, "2,x");
    const page = await shop.owner.get(
      requireValue(sent.location, "The delete sent the owner nowhere"),
    );

    expect(textOf(page.html)).toContain(
      "The answers to delete are not valid. Open the page again.",
    );
    expect(await tabText(shop)).toContain(hidden(2));
  });

  for (const [list, path] of LIST_PAGES) {
    test(`${list} names each attendee with warnings, and what is wrong`, async () => {
      const shop = await bookedThree();
      await setQuantity(shop, 2);

      const page = textOf((await shop.owner.get(path(shop))).html);

      expect(page).toContain(`1 attendee has warnings PTA Parent ${hidden(1)}`);
    });

    test(`${list} shows no warnings summary when no attendee has one`, async () => {
      const shop = await bookedThree();

      const page = textOf((await shop.owner.get(path(shop))).html);

      expect(page).not.toContain("has warnings");
    });
  }
});
