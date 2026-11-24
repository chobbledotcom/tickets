/** The booking page fields of a question that asks once for each listing, and
 * the answers that the booking form refuses. The paid and free journeys are
 * in line-answers.test.ts. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  addGlowPack,
  addQuestion,
  attendeeIds,
  attendeePage,
  book,
  bookAndRead,
  type Discos,
  fieldFor,
  openDiscos,
  type PupilShop,
  pupilNames,
  textOf,
  withPupilName,
} from "#test/blackbox/discos.ts";
import { createApp, inProcess } from "#test/blackbox/driver.ts";
import type { SeededListing } from "#test/blackbox/seed.ts";
import { describeWithEnv } from "#test-utils/db.ts";

/** The longest answer that the field takes, as its `maxlength` says. */
const LIMIT = 10240;

/** The page-level question blocks of a booking page, in page order. */
const questionBlocks = (html: string): string[] =>
  html.match(/<fieldset class="custom-question"[\s\S]*?<\/fieldset>/g) ?? [];

/** One line's field of a question block, with the answer that it shows. A
 * line under a parent takes its quantity from the child's choice under that
 * parent, and any other line from its own quantity. */
const fieldOf = (
  question: number,
  listing: SeededListing,
  words: string,
  { parent, value = "" }: { parent?: SeededListing; value?: string } = {},
) => {
  const line = `${listing.id}_${parent?.id ?? 0}_0`;
  const sources =
    parent === undefined ? `q:${listing.id}` : `c:${parent.id}:${listing.id}`;
  return `<label class="custom-question" data-line="${line}" data-sources="${sources}" data-unit="0">${words}<input maxlength="${LIMIT}" name="${fieldFor(question, listing, { parent })}" type="text" value="${value}"></label>`;
};

/** A question block: the legend, the listings it asks, and their fields. */
const blockOf = (legend: string, listings: SeededListing[], fields: string[]) =>
  `<fieldset class="custom-question" data-listing-ids="${listings.map(({ id }) => id).join(" ")}"><legend>${legend}</legend>${fields.join("")}</fieldset>`;

const bothDiscos = ({ discoA, discoB }: Discos) =>
  `/ticket/${discoA.slug}+${discoB.slug}`;

/** The "Pupil name" block of both discos, with the names that it shows. */
const bothDiscosBlock = ({ discoA, discoB, question }: PupilShop, forA = "") =>
  blockOf(
    "Pupil name",
    [discoA, discoB],
    [
      fieldOf(question, discoA, "Disco A", { value: forA }),
      fieldOf(question, discoB, "Disco B"),
    ],
  );

/** Pupil names for disco B that the form refuses, and the message it shows. */
const REFUSED: [string, string | null, string][] = [
  ["left out", null, "Please answer: Pupil name (Disco B)"],
  ["blank", "   ", "Please answer: Pupil name (Disco B)"],
  [
    "over the length limit",
    "x".repeat(LIMIT + 1),
    "Answer is too long: Pupil name (Disco B)",
  ],
];

describeWithEnv(
  "the booking form of a question that asks once for each listing",
  { db: true },
  () => {
    test("shows the question once, with one field for each listing, and marks no field required", async () => {
      const shop = await withPupilName(await openDiscos());

      const page = await createApp(inProcess).get(bothDiscos(shop));

      expect(questionBlocks(page.html)).toEqual([bothDiscosBlock(shop)]);
    });

    test("a question asked on one listing shows a field for that listing only", async () => {
      const discos = await openDiscos();
      const { discoB } = discos;
      const { question } = await withPupilName(discos, discoB);

      const page = await createApp(inProcess).get(bothDiscos(discos));

      expect(questionBlocks(page.html)).toEqual([
        blockOf("Pupil name", [discoB], [fieldOf(question, discoB, "Disco B")]),
      ]);
    });

    test("a question that asks once for the booking stays one field", async () => {
      const discos = await openDiscos();
      const note = await addQuestion(discos.owner, "Note", "booking");

      const page = await createApp(inProcess).get(bothDiscos(discos));

      expect(page.html).toContain(`name="question${note}"`);
      expect(page.html).not.toContain(`name="question${note}_listing`);
    });

    test("a child listing that the buyer can add gets its own field, once", async () => {
      const discos = await openDiscos();
      const glowPack = await addGlowPack(discos, [discos.discoA]);
      const { discoA, question } = await withPupilName(discos);

      const page = await createApp(inProcess).get(`/ticket/${discoA.slug}`);

      expect(questionBlocks(page.html)).toEqual([
        blockOf(
          "Pupil name",
          [discoA, glowPack],
          [
            fieldOf(question, discoA, "Disco A"),
            fieldOf(question, glowPack, "Glow Pack with Disco A", {
              parent: discoA,
            }),
          ],
        ),
      ]);
    });

    test("a question asked only on a child listing shows at page level, and a booking question stays in the child's block", async () => {
      const discos = await openDiscos();
      const glowPack = await addGlowPack(discos, [discos.discoA]);
      const { question } = await withPupilName(discos, glowPack);
      const note = await addQuestion(discos.owner, "Note", "booking", glowPack);

      const page = await createApp(inProcess).get(
        `/ticket/${discos.discoA.slug}`,
      );

      expect(questionBlocks(page.html)).toEqual([
        blockOf(
          "Pupil name",
          [glowPack],
          [
            fieldOf(question, glowPack, "Glow Pack with Disco A", {
              parent: discos.discoA,
            }),
          ],
        ),
      ]);
      expect(page.html).toMatch(
        new RegExp(
          `<fieldset class="child-selector"[^>]*>(?:(?!</fieldset>).)*name="question${note}"`,
        ),
      );
    });

    test("a refused order shows each typed answer again under its own listing", async () => {
      const shop = await withPupilName(await openDiscos());

      const page = await bookAndRead(
        shop,
        [1, 1],
        pupilNames(shop, "Ava", null),
      );

      expect(questionBlocks(page)).toEqual([bothDiscosBlock(shop, "Ava")]);
    });

    for (const [name, forB, message] of REFUSED) {
      test(`an answer that is ${name} stops the order, and the refusal names the listing`, async () => {
        const shop = await withPupilName(await openDiscos());

        const page = await bookAndRead(
          shop,
          [1, 1],
          pupilNames(shop, "Ava", forB),
        );

        expect(textOf(page)).toContain(message);
        expect(await attendeeIds(shop.api, shop.discoA)).toEqual([]);
        expect(await attendeeIds(shop.api, shop.discoB)).toEqual([]);
      });
    }

    test("an answer at the length limit is kept", async () => {
      const shop = await withPupilName(await openDiscos());
      const atLimit = "x".repeat(LIMIT);

      await book(shop, [1, 0], pupilNames(shop, atLimit, null));

      expect(await attendeePage(shop)).toContain(
        `Pupil name (Disco A) ${atLimit} `,
      );
    });

    test("an answer is kept without the spaces around it, on each listing that it answers", async () => {
      const shop = await withPupilName(await openDiscos());

      await book(shop, [1, 1], pupilNames(shop, "  Sam  ", "Sam"));
      const [id] = await attendeeIds(shop.api, shop.discoA);
      const page = await shop.owner.get(`/admin/attendees/${id}`);

      expect(page.html.split("<td>Sam</td>").length - 1).toBe(2);
      expect(textOf(page.html)).toContain(
        "Pupil name (Disco A) Sam Pupil name (Disco B) Sam",
      );
    });
  },
);
