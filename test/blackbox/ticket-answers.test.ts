/** A free-text question that asks once for each ticket. A line of quantity 2
 * owes two answers. The booking page offers a field for each ticket that a
 * line can take, the submit refuses a missing or an extra answer, and the
 * owner reads each answer under its line and ticket. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  attendeeIds,
  attendeePage,
  book,
  bookAndRead,
  fieldFor,
  openDiscos,
  type PupilShop,
  textOf,
  withPupilName,
} from "#test/blackbox/discos.ts";
import { createApp, type Fields, inProcess } from "#test/blackbox/driver.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const HEADING = "Answers for each listing";

/** The pupil names of a shop, ticket by ticket, on disco A then disco B. */
const ticketNames = (
  { discoA, discoB, question }: PupilShop,
  forA: readonly string[],
  forB: readonly string[] = [],
): Fields =>
  Object.fromEntries([
    ...forA.map((name, at) => [
      fieldFor(question, discoA, { ticket: at + 1 }),
      name,
    ]),
    ...forB.map((name, at) => [
      fieldFor(question, discoB, { ticket: at + 1 }),
      name,
    ]),
  ]);

const ticketShop = async () =>
  withPupilName(await openDiscos(), undefined, "quantity");

/** Orders that the form refuses: the places booked on each disco, the names
 * typed for disco A, and the message the refusal shows. */
const REFUSED: [string, [number, number], string[], string][] = [
  [
    "leaves out a ticket's answer",
    [2, 0],
    ["Ava"],
    "Please answer: Pupil name (Disco A, ticket 2)",
  ],
  [
    "answers a ticket that the order does not take",
    [1, 0],
    ["Ava", "Amy"],
    "You did not book this, so clear its answer: Pupil name (Disco A, ticket 2)",
  ],
];

describeWithEnv(
  "a question that asks once for each ticket",
  { db: true },
  () => {
    test("keeps one answer for each ticket, and the attendee page shows each under its line and ticket", async () => {
      const shop = await ticketShop();

      const sent = await book(
        shop,
        [2, 1],
        ticketNames(shop, ["Ava", "Amy"], ["Ben"]),
      );

      expect(sent.status).toBe(302);
      expect(await attendeePage(shop)).toContain(
        `${HEADING} Pupil name (Disco A, ticket 1) Ava Pupil name (Disco A, ticket 2) Amy Pupil name (Disco B, ticket 1) Ben`,
      );
    });

    test("keeps two tickets that share a name", async () => {
      const shop = await ticketShop();

      await book(shop, [2, 0], ticketNames(shop, ["Sam", "Sam"]));

      expect(await attendeePage(shop)).toContain(
        "Pupil name (Disco A, ticket 1) Sam Pupil name (Disco A, ticket 2) Sam",
      );
    });

    test("the booking page offers a field for each ticket that a line can take", async () => {
      const shop = await ticketShop();

      const page = await createApp(inProcess).get(
        `/ticket/${shop.discoA.slug}+${shop.discoB.slug}`,
      );

      const names = [
        ...page.html.matchAll(/name="(question\d+_line[^"]+)"/g),
      ].map(([, name]) => name);
      const tickets = [1, 2, 3, 4, 5];
      expect(names).toEqual([
        ...tickets.map((ticket) =>
          fieldFor(shop.question, shop.discoA, { ticket }),
        ),
        ...tickets.map((ticket) =>
          fieldFor(shop.question, shop.discoB, { ticket }),
        ),
      ]);
    });

    for (const [name, counts, forA, message] of REFUSED) {
      test(`an order that ${name} is refused, names the ticket, and books nothing`, async () => {
        const shop = await ticketShop();

        const page = await bookAndRead(shop, counts, ticketNames(shop, forA));

        expect(textOf(page)).toContain(message);
        expect(await attendeeIds(shop.api, shop.discoA)).toEqual([]);
      });
    }

    test("a blank field for a ticket that the order does not take is no answer", async () => {
      const shop = await ticketShop();

      const sent = await book(
        shop,
        [1, 0],
        ticketNames(shop, ["Ava", "  "], ["", ""]),
      );

      expect(sent.status).toBe(302);
      expect(await attendeePage(shop)).toContain(
        `${HEADING} Pupil name (Disco A, ticket 1) Ava`,
      );
    });
  },
);
