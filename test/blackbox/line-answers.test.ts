/** A free-text question that asks once for each listing. The owner adds it on
 * the questions page. A buyer who books two listings gives one answer for
 * each. The owner reads each answer, with its listing, on the attendee's page.
 * A paid order carries the answers through the sealed order, not through
 * Stripe. The booking form's fields and refusals are in
 * line-answer-form.test.ts. */

import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { requireValue } from "#shared/required-value.ts";
import { deliverPayment, openCardShop } from "#test/blackbox/card-shop.ts";
import {
  addDiscos,
  addQuestion,
  attendeeIds,
  attendeePage,
  book,
  openDiscos,
  pupilNames,
  withPupilName,
} from "#test/blackbox/discos.ts";
import type { FakeStripe } from "#test/blackbox/fake-stripe.ts";
import { addBooking } from "#test/blackbox/seed.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const HEADING = t("attendee_detail.line_answers");

const BOTH_NAMES = `${HEADING} Pupil name (Disco A) Ava Pupil name (Disco B) Ben`;

/** Free orders of the names Ava and Ben: the places booked on each disco, the
 * text that the attendee page shows, and text that it must not show. */
const FREE_ORDERS: [string, [number, number], string, string][] = [
  [
    "keeps one answer for each listing, and the attendee page shows each with its listing",
    [2, 2],
    BOTH_NAMES,
    "Pupil name (Disco A) Ben",
  ],
  [
    "needs no answer for a listing that it does not book, and does not keep an answer typed for it",
    [1, 0],
    `${HEADING} Pupil name (Disco A) Ava`,
    "Ben",
  ],
];

describeWithEnv(
  "a question that asks once for each listing",
  { db: true },
  () => {
    let fake: FakeStripe | undefined;
    afterEach(async () => {
      await fake?.close();
      fake = undefined;
    });

    for (const [name, counts, shown, notShown] of FREE_ORDERS) {
      test(`a free order ${name}`, async () => {
        const shop = await withPupilName(await openDiscos());

        const booked = await book(shop, counts, pupilNames(shop, "Ava", "Ben"));

        expect(booked.status).toBe(302);
        const page = await attendeePage(shop);
        expect(page).toContain(shown);
        expect(page).not.toContain(notShown);
      });
    }

    test("a paid order keeps the answers out of Stripe, and the webhook files each against its listing", async () => {
      const cardShop = await openCardShop();
      fake = cardShop.fake;
      const shop = await withPupilName(
        await addDiscos(cardShop.owner, cardShop.api, 500),
      );

      const sent = await book(shop, [2, 2], pupilNames(shop, "Ava", "Ben"));
      const checkout = requireValue(
        cardShop.fake.checkouts.at(-1),
        "The app opened no checkout",
      );

      expect(sent.location).toMatch(/^https:\/\/checkout\.stripe\.test\//);
      expect(checkout.amountTotal).toBe(2000);
      expect(JSON.stringify(checkout.metadata)).not.toMatch(/Ava|Ben/);
      expect(await attendeeIds(shop.api, shop.discoA)).toEqual([]);

      expect((await deliverPayment(cardShop, checkout)).status).toBe(200);

      expect(await attendeePage(shop)).toContain(BOTH_NAMES);
    });

    test("a choice question asks once for the booking, whatever level the form sends", async () => {
      const { api, owner } = await openDiscos();

      const added = await owner.submit("/admin/questions", {
        answerLevel: "listing",
        displayType: "radio",
        text: "Size",
      });
      const id = added.location?.match(/\/admin\/questions\/(\d+)/)?.[1];
      const row = await api.get(`/api/admin/questions/${id}`);

      expect(row.body).toMatchObject({
        question: { answer_level: "booking", display_type: "radio" },
      });
    });

    test("an attendee with no answer for a listing has no such section", async () => {
      const discos = await openDiscos();
      await addBooking(discos.api, discos.discoA, { name: "Walk In" });

      expect(await attendeePage(discos)).not.toContain(HEADING);
    });

    test("the edit form of an attendee offers no field for a question that asks once for each listing", async () => {
      const shop = await withPupilName(await openDiscos());
      const note = await addQuestion(shop.owner, "Note", "booking");
      await book(shop, [1, 0], {
        ...pupilNames(shop, "Ava", null),
        [`question${note}`]: "Nut allergy",
      });
      const [id] = await attendeeIds(shop.api, shop.discoA);

      const form = await shop.owner.get(
        `/admin/attendees/${requireValue(id, "Disco A has no booking")}/edit`,
      );

      expect(form.html).toContain(`name="question${note}"`);
      expect(form.html).not.toContain(`name="question${shop.question}`);
    });
  },
);
