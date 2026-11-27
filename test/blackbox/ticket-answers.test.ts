/** A free-text question that asks once for each ticket. A line of quantity 2
 * owes two answers. The booking page offers a field for each ticket that a
 * line can take, the submit refuses a missing or an extra answer, and the
 * owner reads each answer under its line and ticket. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { requireValue } from "#shared/required-value.ts";
import {
  addPartyPack,
  attendeeIds,
  attendeePage,
  book,
  bookAndRead,
  fieldFor,
  openDiscos,
  textOf,
  ticketNames,
  withPupilName,
} from "#test/blackbox/discos.ts";
import { createApp, inProcess } from "#test/blackbox/driver.ts";
import type { SeededListing } from "#test/blackbox/seed.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const HEADING = "Answers for each listing";

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

type TicketShop = Awaited<ReturnType<typeof ticketShop>>;

const NO_SUCH_ID = 999_999;

const absent = (shop: TicketShop): SeededListing => ({
  ...shop.discoA,
  id: NO_SUCH_ID,
});

/** Crafted answer fields that name something the order does not book: the
 * field, and the words for it in the refusal. A field that names a question,
 * listing or package that the page does not know keeps its own name. */
const CRAFTED: [
  string,
  (shop: TicketShop) => string,
  (shop: TicketShop) => string,
][] = [
  [
    "a question that the page does not ask",
    (shop) => fieldFor(NO_SUCH_ID, shop.discoA),
    (shop) => fieldFor(NO_SUCH_ID, shop.discoA),
  ],
  [
    "a listing that the page does not offer",
    (shop) => fieldFor(shop.question, absent(shop)),
    (shop) => fieldFor(shop.question, absent(shop)),
  ],
  [
    "a package that the page does not offer",
    (shop) => fieldFor(shop.question, shop.discoA, { packageId: NO_SUCH_ID }),
    (shop) => fieldFor(shop.question, shop.discoA, { packageId: NO_SUCH_ID }),
  ],
  [
    "a line under a parent that the order does not book",
    (shop) => fieldFor(shop.question, shop.discoA, { parent: shop.discoB }),
    () => "Pupil name (Disco A with Disco B, ticket 1)",
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
      expect(textOf(page.html)).toContain(
        tickets.map((ticket) => `Disco A, ticket ${ticket}`).join(" "),
      );
    });

    for (const [name, counts, forA, message] of REFUSED) {
      test(`an order that ${name} is refused, names the ticket, and books nothing`, async () => {
        const shop = await ticketShop();

        const page = await bookAndRead(shop, counts, ticketNames(shop, forA));

        expect(textOf(page)).toContain(message);
        expect(await attendeeIds(shop.api, shop.discoA)).toEqual([]);
      });
    }

    test("the booking page of a package offers a field for each ticket that its packs can hold", async () => {
      const shop = await ticketShop();
      const pack = await addPartyPack(shop, [shop.discoA], { quantity: 2 });

      const page = await createApp(inProcess).get(`/ticket/${pack.slug}`);

      const packs = [
        ...requireValue(
          page.html.match(
            new RegExp(
              `<select[^>]*name="packageQuantity${pack.id}"[\\s\\S]*?</select>`,
            ),
          ),
          "The page offers no pack count",
        )[0].matchAll(/<option value="(\d+)"/g),
      ].map(([, value]) => Number(value));
      const tickets = [
        ...page.html.matchAll(/name="(question\d+_line[^"]+)"/g),
      ];
      expect(tickets.map(([, name]) => name)).toEqual(
        Array.from({ length: 2 * Math.max(...packs) }, (_, at) =>
          fieldFor(shop.question, shop.discoA, {
            packageId: pack.id,
            ticket: at + 1,
          }),
        ),
      );
    });

    for (const [name, field, words] of CRAFTED) {
      test(`an answer for ${name} is refused, and books nothing`, async () => {
        const shop = await ticketShop();

        const page = await bookAndRead(shop, [1, 0], {
          ...ticketNames(shop, ["Ava"]),
          [field(shop)]: "Zed",
        });

        expect(textOf(page)).toContain(
          `You did not book this, so clear its answer: ${words(shop)}`,
        );
        expect(await attendeeIds(shop.api, shop.discoA)).toEqual([]);
      });
    }

    test("the running total of an order with an unanswered ticket names that ticket", async () => {
      const shop = await ticketShop();
      const slugs = `${shop.discoA.slug}+${shop.discoB.slug}`;

      const quote = await createApp(inProcess).submit(
        `/ticket/${slugs}`,
        { [`quantity${shop.discoA.id}`]: "1" },
        `/calculate/${slugs}`,
      );

      expect([quote.status, textOf(quote.html).trim()]).toEqual([
        200,
        "Please answer: Pupil name (Disco A, ticket 1)",
      ]);
    });

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

    test("the attendee CSV of a listing holds one column for each ticket", async () => {
      const shop = await ticketShop();
      await book(shop, [2, 0], ticketNames(shop, ["Ava", "Amy"]));

      const csv = await shop.owner.get(
        `/admin/listing/${shop.discoA.id}/export`,
      );
      const [header, row] = csv.html.trim().split("\n");

      expect(
        header?.endsWith(",Pupil name (ticket 1),Pupil name (ticket 2)"),
      ).toBe(true);
      expect(row?.endsWith(",Ava,Amy")).toBe(true);
    });
  },
);
