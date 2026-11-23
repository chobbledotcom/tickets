/** The booking page fields of a question that asks once for each listing, and
 * the answers that the booking form refuses. The paid and free journeys are
 * in line-answers.test.ts. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  addQuestion,
  attendeeIds,
  attendeePage,
  book,
  type Discos,
  fieldFor,
  openDiscos,
  textOf,
} from "#test/blackbox/discos.ts";
import { createApp, inProcess } from "#test/blackbox/driver.ts";
import { addListing, type SeededListing } from "#test/blackbox/seed.ts";
import { describeWithEnv } from "#test-utils/db.ts";

/** The longest answer that the field takes, as its `maxlength` says. */
const LIMIT = 10240;

/** The page-level question blocks of a booking page, in page order. */
const questionBlocks = (html: string): string[] =>
  html.match(/<fieldset class="custom-question"[\s\S]*?<\/fieldset>/g) ?? [];

/** One listing's field of a question block, with the answer that it shows. */
const fieldOf = (
  question: number,
  listing: SeededListing,
  name: string,
  value = "",
) =>
  `<label class="custom-question" data-listing-ids="${listing.id}">${name}<input maxlength="${LIMIT}" name="${fieldFor(question, listing)}" type="text" value="${value}"></label>`;

/** A question block: the legend, the listings it asks, and their fields. */
const blockOf = (legend: string, listings: SeededListing[], fields: string[]) =>
  `<fieldset class="custom-question" data-listing-ids="${listings.map(({ id }) => id).join(" ")}"><legend>${legend}</legend>${fields.join("")}</fieldset>`;

const bothDiscos = ({ discoA, discoB }: Discos) =>
  `/ticket/${discoA.slug}+${discoB.slug}`;

/** A parent books one place on disco A with this answer, and reads the page
 * that the form sends them back to. */
const bookDiscoA = async (discos: Discos, question: number, answer: string) => {
  const buyer = createApp(inProcess);
  const sent = await book(
    discos,
    [1, 0],
    { [fieldFor(question, discos.discoA)]: answer },
    buyer,
  );
  return textOf((await buyer.get(sent.location ?? "")).html);
};

/** Disco A gets a child listing that a buyer can add to it. */
const addGlowPack = async ({ api, discoA }: Discos): Promise<SeededListing> => {
  const child = await addListing(api, {
    max_attendees: 20,
    max_quantity: 5,
    name: "Glow Pack",
    unit_price: 0,
  });
  await api.put(`/api/admin/listings/${discoA.id}`, {
    child_listing_ids: [child.id],
  });
  return child;
};

describeWithEnv(
  "the booking form of a question that asks once for each listing",
  { db: true },
  () => {
    test("shows the question once, with one field for each listing, and marks no field required", async () => {
      const discos = await openDiscos();
      const { discoA, discoB } = discos;
      const question = await addQuestion(discos.owner, "Pupil name", "listing");

      const page = await createApp(inProcess).get(bothDiscos(discos));

      expect(questionBlocks(page.html)).toEqual([
        blockOf(
          "Pupil name",
          [discoA, discoB],
          [
            fieldOf(question, discoA, "Disco A"),
            fieldOf(question, discoB, "Disco B"),
          ],
        ),
      ]);
    });

    test("a question asked on one listing shows a field for that listing only", async () => {
      const discos = await openDiscos();
      const { discoB } = discos;
      const question = await addQuestion(
        discos.owner,
        "Pupil name",
        "listing",
        discoB,
      );

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
      const glowPack = await addGlowPack(discos);
      const question = await addQuestion(discos.owner, "Pupil name", "listing");

      const page = await createApp(inProcess).get(
        `/ticket/${discos.discoA.slug}`,
      );

      expect(questionBlocks(page.html)).toEqual([
        blockOf(
          "Pupil name",
          [discos.discoA, glowPack],
          [
            fieldOf(question, discos.discoA, "Disco A"),
            fieldOf(question, glowPack, "Glow Pack"),
          ],
        ),
      ]);
    });

    test("a question asked only on a child listing shows at page level, and a booking question stays in the child's block", async () => {
      const discos = await openDiscos();
      const glowPack = await addGlowPack(discos);
      const pupil = await addQuestion(
        discos.owner,
        "Pupil name",
        "listing",
        glowPack,
      );
      const note = await addQuestion(discos.owner, "Note", "booking", glowPack);

      const page = await createApp(inProcess).get(
        `/ticket/${discos.discoA.slug}`,
      );

      expect(questionBlocks(page.html)).toEqual([
        blockOf(
          "Pupil name",
          [glowPack],
          [fieldOf(pupil, glowPack, "Glow Pack")],
        ),
      ]);
      expect(page.html).toMatch(
        new RegExp(
          `<fieldset class="child-selector"[^>]*>(?:(?!</fieldset>).)*name="question${note}"`,
        ),
      );
    });

    test("a refused order shows each typed answer again under its own listing", async () => {
      const discos = await openDiscos();
      const { discoA, discoB } = discos;
      const question = await addQuestion(discos.owner, "Pupil name", "listing");
      const buyer = createApp(inProcess);

      const refused = await book(
        discos,
        [1, 1],
        { [fieldFor(question, discoA)]: "Ava" },
        buyer,
      );
      const page = await buyer.get(refused.location ?? "");

      expect(questionBlocks(page.html)).toEqual([
        blockOf(
          "Pupil name",
          [discoA, discoB],
          [
            fieldOf(question, discoA, "Disco A", "Ava"),
            fieldOf(question, discoB, "Disco B"),
          ],
        ),
      ]);
    });

    test("a post that leaves out the field of a booked listing is refused", async () => {
      const discos = await openDiscos();
      const question = await addQuestion(discos.owner, "Pupil name", "listing");
      const buyer = createApp(inProcess);

      const refused = await book(
        discos,
        [1, 1],
        {
          [fieldFor(question, discos.discoA)]: "Ava",
          [fieldFor(question, discos.discoB)]: null,
        },
        buyer,
      );
      const shown = await buyer.get(refused.location ?? "");

      expect(textOf(shown.html)).toContain(
        "Please answer: Pupil name (Disco B)",
      );
      expect(await attendeeIds(discos.api, discos.discoA)).toEqual([]);
    });

    test("a blank answer is refused, and the refusal names the listing", async () => {
      const discos = await openDiscos();
      const question = await addQuestion(discos.owner, "Pupil name", "listing");

      const shown = await bookDiscoA(discos, question, "   ");

      expect(shown).toContain("Please answer: Pupil name (Disco A)");
      expect(await attendeeIds(discos.api, discos.discoA)).toEqual([]);
    });

    test("an answer over the length limit is refused, and one at the limit is kept", async () => {
      const discos = await openDiscos();
      const question = await addQuestion(discos.owner, "Pupil name", "listing");
      const atLimit = "x".repeat(LIMIT);

      const shown = await bookDiscoA(discos, question, `${atLimit}x`);

      expect(shown).toContain("Answer is too long: Pupil name (Disco A)");
      expect(await attendeeIds(discos.api, discos.discoA)).toEqual([]);

      await bookDiscoA(discos, question, atLimit);

      expect(await attendeePage(discos)).toContain(
        `Pupil name (Disco A) ${atLimit} `,
      );
    });

    test("an answer keeps its words without the spaces around them, and two listings can share one answer", async () => {
      const discos = await openDiscos();
      const { discoA, discoB } = discos;
      const question = await addQuestion(discos.owner, "Pupil name", "listing");

      await book(discos, [1, 1], {
        [fieldFor(question, discoA)]: "  Sam  ",
        [fieldFor(question, discoB)]: "Sam",
      });
      const [id] = await attendeeIds(discos.api, discoA);
      const edit = await discos.owner.get(`/admin/attendees/${id}`);

      expect(edit.html).toContain("<td>Sam</td>");
      expect(await attendeePage(discos)).toContain(
        "Pupil name (Disco A) Sam Pupil name (Disco B) Sam",
      );
    });
  },
);
